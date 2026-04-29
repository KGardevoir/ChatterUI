import * as Speech from 'expo-speech'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'

import { Storage } from '@lib/enums/Storage'
import { Logger } from '@lib/state/Logger'
import { createMMKVStorage } from '@lib/storage/MMKV'

import { Chats, useInference } from './Chat'

type TTSState = {
    activeChatIndex?: number
    voice?: Speech.Voice
    enabled: boolean
    auto: boolean
    rate: number
    startTTS: (text: string, index: number) => Promise<void>
    stopTTS: () => Promise<void>
    setEnabled: (b: boolean) => void
    setAuto: (b: boolean) => void
    setVoice: (v: Speech.Voice) => void
    setRate: (r: number) => void
    setLiveTTS: (b: boolean) => void

    speak: (text: string, onDone?: () => void, onStop?: () => void) => void
    handleEndGeneration: (lastIndex: number, text: string) => Promise<void>
    handleStartGeneration: (lastIndex: number) => void
    // stream TTS
    liveTTS: boolean
    pauseLive?: boolean
    setPauseLive: (b: boolean) => void
    buffer: string
    clearAndRunBuffer: (lastIndex: number) => void
    clearBuffer: () => void
    /**
     * Inserts text into the buffer, attempts TTS if valid sentence and adds remainder to buffer
     * @param text text for TTS
     * @returns
     */
    insertBuffer: (text: string) => void
}

const sentenceEndRegex =
    /(?<=[^\d])([。…？！.?!])(?:["'`*_)]*)\s+(?=[A-Z0-9])|([。…？！.?!])(?:["'`*_)]*)$/gm

export const useTTS = () => {
    const {
        startTTS,
        activeChatIndex,
        stopTTS,
        setVoice,
        setEnabled,
        setAuto,
        setRate,
        auto,
        enabled,
        voice,
        rate,
        live,
        setLive,
    } = useTTSStore(
        useShallow((state) => ({
            startTTS: state.startTTS,
            stopTTS: state.stopTTS,
            activeChatIndex: state.activeChatIndex,
            setVoice: state.setVoice,
            setEnabled: state.setEnabled,
            setAuto: state.setAuto,
            setRate: state.setRate,
            auto: state.auto,
            enabled: state.enabled,
            voice: state.voice,
            rate: state.rate,
            live: state.liveTTS,
            setLive: state.setLiveTTS,
        }))
    )
    return {
        startTTS,
        activeChatIndex,
        stopTTS,
        setVoice,
        setEnabled,
        setAuto,
        setRate,
        auto,
        enabled,
        voice,
        rate,
        live,
        setLive,
    }
}

useInference.subscribe(({ nowGenerating }) => {
    const data = Chats.useChatState.getState().data
    const length = data?.messages?.length
    if (!length) return
    if (!nowGenerating) {
        const message = data?.messages?.[length - 1]
        if (!message) return
        useTTSStore
            .getState()
            .handleEndGeneration(length - 1, message.swipes[message.swipe_id].swipe)
    } else {
        useTTSStore.getState().handleStartGeneration(length - 1)
    }
})

export const useTTSStore = create<TTSState>()(
    persist(
        (set, get) => ({
            voice: undefined,
            enabled: false,
            auto: false,
            liveTTS: false,
            rate: 1,
            activeChatIndex: undefined,
            startTTS: async (text: string, index: number) => {
                const clearIndex = () => {
                    if (get().activeChatIndex === index) set({ activeChatIndex: undefined })
                }

                const currentSpeaker = get().voice

                Logger.info('Starting TTS')
                if (currentSpeaker === undefined) {
                    Logger.errorToast(`No Speaker Chosen`)
                    clearIndex()
                    return
                }
                // Strip thinking/reasoning sections before speaking
                const strippedText = stripThinkTags(text).trim()
                if (!strippedText) {
                    clearIndex()
                    return
                }
                if (await Speech.isSpeakingAsync()) await Speech.stop()
                const filter = /([。…！？、!?.,*"])/
                const filteredchunks: string[] = []
                const chunks = strippedText.split(filter)
                chunks.forEach((item, index) => {
                    if (!filter.test(item) && item) return filteredchunks.push(item)
                    if (index > 0)
                        filteredchunks[filteredchunks.length - 1] =
                            filteredchunks[filteredchunks.length - 1] + item
                })
                if (filteredchunks.length === 0) filteredchunks.push(strippedText)

                const cleanedchunks = filteredchunks.map((item) =>
                    item.replaceAll(/[*"]/g, '').trim()
                )
                Logger.debug('TTS started with ' + cleanedchunks.length + ' chunks')
                set({ activeChatIndex: index })
                cleanedchunks.forEach((chunk, index) =>
                    Speech.speak(chunk, {
                        language: currentSpeaker?.language,
                        voice: currentSpeaker?.identifier,
                        onDone: () => {
                            index === cleanedchunks.length - 1 && clearIndex()
                        },
                        onStopped: () => clearIndex(),
                        rate: get().rate,
                    })
                )
                if (cleanedchunks.length === 0) clearIndex()
            },
            stopTTS: async () => {
                Logger.info('TTS stopped')
                set({ buffer: '', activeChatIndex: undefined, pauseLive: get().liveTTS })
                await Speech.stop()
            },
            setEnabled: (b: boolean) => {
                set({ enabled: b })
            },
            setAuto: (b: boolean) => {
                set({ auto: b })
            },
            setVoice: (v: Speech.Voice) => {
                set({ voice: v })
            },
            setRate: (r: number) => {
                set({ rate: r })
            },
            setLiveTTS: (b: boolean) => {
                set({ liveTTS: b })
            },
            setPauseLive: (b: boolean) => {
                set({ pauseLive: b })
            },
            speak: (text, onDone = () => {}, onStop = () => {}) => {
                const currentSpeaker = get().voice
                Speech.speak(text, {
                    language: currentSpeaker?.language,
                    voice: currentSpeaker?.identifier,
                    onDone: onDone,
                    onStopped: onStop,
                    rate: get().rate,
                })
            },

            handleEndGeneration: async (lastIndex, text) => {
                if (!get().enabled) return
                if (get().liveTTS) {
                    get().clearAndRunBuffer(lastIndex)
                } else if (get().auto) {
                    await get().stopTTS()
                    get().startTTS(text, lastIndex)
                }
            },

            handleStartGeneration: async (lastIndex) => {
                if (get().enabled && get().liveTTS) {
                    await Speech.stop()
                    set({ activeChatIndex: lastIndex })
                }
                set({ pauseLive: false })
            },

            // Stream Data

            buffer: '',
            clearAndRunBuffer: (lastIndex) => {
                const buffer = get().buffer

                if (!get().pauseLive && buffer.trim()) {
                    // Strip complete think sections, then truncate at any remaining open tag
                    let stripped = stripThinkTags(buffer)
                    const openIdx = findOpenThinkTag(stripped)
                    if (openIdx !== -1) stripped = stripped.slice(0, openIdx)
                    const clean = cleanMarkdown(stripped).trim()
                    if (clean) {
                        set({ activeChatIndex: lastIndex })
                        get().speak(clean, () => set({ activeChatIndex: undefined }))
                    } else {
                        set({ activeChatIndex: undefined })
                    }
                } else {
                    set({ activeChatIndex: undefined })
                }
                set({ buffer: '' })
            },
            clearBuffer: () => {
                set({ buffer: '' })
            },
            insertBuffer: (text: string) => {
                if (!get().enabled || !get().liveTTS || get().pauseLive) return
                let newBuffer = get().buffer + text

                // Remove complete think sections from the accumulated buffer
                newBuffer = stripThinkTags(newBuffer)

                // If an unclosed think-tag opening remains, only process text before it
                // and keep everything from that opening tag onwards for later
                const openIdx = findOpenThinkTag(newBuffer)
                let processable: string
                let holdback: string
                if (openIdx !== -1) {
                    processable = newBuffer.slice(0, openIdx)
                    holdback = newBuffer.slice(openIdx)
                } else {
                    processable = newBuffer
                    holdback = ''
                }

                let lastMatchIndex = -1

                while (sentenceEndRegex.exec(processable) !== null) {
                    lastMatchIndex = sentenceEndRegex.lastIndex
                }

                if (lastMatchIndex !== -1) {
                    const fullSentence = processable.slice(0, lastMatchIndex).trim()
                    const remainder = processable.slice(lastMatchIndex)
                    const clean = cleanMarkdown(fullSentence)
                    if (clean) {
                        get().speak(clean)
                    }
                    set({ buffer: remainder + holdback })
                } else {
                    set({ buffer: processable + holdback })
                }
            },
        }),
        {
            name: Storage.TTS,
            storage: createMMKVStorage(),
            version: 1,
            partialize: (state) => ({
                enabled: state.enabled,
                auto: state.auto,
                voice: state.voice,
                rate: state.rate,
                liveTTS: state.liveTTS,
            }),
        }
    )
)

// Removes complete <think>, <|channel>thought, and <seed:think> sections including their content
const stripThinkTags = (text: string): string => {
    let result = text
    result = result.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    result = result.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    result = result.replace(/<seed:think>[\s\S]*?<\/seed:think>/gi, '')
    return result
}

// Returns the index of the first unclosed think-tag opening, or -1 if none
const findOpenThinkTag = (text: string): number => {
    const match = /(<think\b[^>]*>|<\|channel>thought|<seed:think>)/i.exec(text)
    return match ? match.index : -1
}

const cleanMarkdown = (text: string): string => {
    const result = text.replace(/([*_]{1,2}|`|\[\^.*?\]\(.*?\)|<\/?[^>]+>)/g, '')
    return result
}
