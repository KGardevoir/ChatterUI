#!/usr/bin/env bash
# setup-ci-secrets.sh
#
# Generates (or imports) an Android signing keystore and uploads all required
# CI secrets to GitHub so the build-android.yml workflow can sign APKs.
#
# Prerequisites:
#   - gh CLI  (https://cli.github.com) — authenticated with `gh auth login`
#   - keytool — ships with any JDK (java -version to check)
#   - openssl  — available on macOS/Linux by default
#
# Usage:
#   # First-time setup (generates a new keystore):
#   ./scripts/setup-ci-secrets.sh
#
#   # Import an existing keystore:
#   KEYSTORE_FILE=path/to/existing.jks ./scripts/setup-ci-secrets.sh

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '')}"
KEYSTORE_FILE="${KEYSTORE_FILE:-./chatterui-release.keystore}"
KEY_ALIAS="${KEY_ALIAS:-chatterui}"
VALIDITY_DAYS="${VALIDITY_DAYS:-36500}"   # 100 years
DNAME="${DNAME:-CN=ChatterUI, OU=Mobile, O=ChatterUI, L=Unknown, ST=Unknown, C=US}"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

require_cmd() { command -v "$1" &>/dev/null || die "'$1' not found. $2"; }

# ── Preflight checks ──────────────────────────────────────────────────────────

require_cmd gh      "Install from https://cli.github.com"
require_cmd keytool "Install a JDK: https://adoptium.net"
require_cmd base64  ""

gh auth status &>/dev/null || die "Not logged in to GitHub. Run: gh auth login"

if [[ -z "$REPO" ]]; then
    die "Could not detect repository. Set REPO=owner/repo or run from inside the git checkout."
fi

echo
info "Target repository : $REPO"
info "Keystore file     : $KEYSTORE_FILE"
info "Key alias         : $KEY_ALIAS"
echo

# ── Keystore generation or import ────────────────────────────────────────────

if [[ -f "$KEYSTORE_FILE" ]]; then
    warn "Keystore already exists at $KEYSTORE_FILE — skipping generation."
    warn "To create a new one, delete the file first or set KEYSTORE_FILE to a new path."
    echo

    # We still need the passwords to upload
    read -r -s -p "Enter keystore password: " KEYSTORE_PASSWORD; echo
    read -r -s -p "Enter key password (leave blank if same as keystore): " KEY_PASSWORD; echo
    KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
else
    info "No keystore found — generating a new one."
    echo
    warn "IMPORTANT: Back up the keystore file after this script completes."
    warn "Losing the keystore means you can never publish a signed upgrade."
    echo

    read -r -s -p "Choose keystore password (min 6 chars): " KEYSTORE_PASSWORD; echo
    [[ ${#KEYSTORE_PASSWORD} -lt 6 ]] && die "Password too short (minimum 6 characters)."
    read -r -s -p "Confirm keystore password: " KEYSTORE_PASSWORD2; echo
    [[ "$KEYSTORE_PASSWORD" != "$KEYSTORE_PASSWORD2" ]] && die "Passwords do not match."

    read -r -s -p "Choose key password (leave blank to reuse keystore password): " KEY_PASSWORD; echo
    KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

    keytool -genkeypair \
        -v \
        -keystore  "$KEYSTORE_FILE" \
        -alias     "$KEY_ALIAS" \
        -keyalg    RSA \
        -keysize   2048 \
        -validity  "$VALIDITY_DAYS" \
        -storepass "$KEYSTORE_PASSWORD" \
        -keypass   "$KEY_PASSWORD" \
        -dname     "$DNAME"

    success "Keystore created at $KEYSTORE_FILE"
fi

# ── Print keystore fingerprint for reference ──────────────────────────────────

echo
info "Keystore fingerprint (SHA-256) — record this for Play Store / sideload verification:"
keytool -list -v \
    -keystore  "$KEYSTORE_FILE" \
    -alias     "$KEY_ALIAS" \
    -storepass "$KEYSTORE_PASSWORD" 2>/dev/null \
  | grep -E "SHA256|SHA1" || true
echo

# ── Upload secrets to GitHub ──────────────────────────────────────────────────

info "Uploading secrets to $REPO ..."

KEYSTORE_B64=$(base64 < "$KEYSTORE_FILE")

gh secret set ANDROID_KEYSTORE          --repo "$REPO" --body "$KEYSTORE_B64"
success "ANDROID_KEYSTORE uploaded"

gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO" --body "$KEYSTORE_PASSWORD"
success "ANDROID_KEYSTORE_PASSWORD uploaded"

gh secret set ANDROID_KEY_ALIAS         --repo "$REPO" --body "$KEY_ALIAS"
success "ANDROID_KEY_ALIAS uploaded"

gh secret set ANDROID_KEY_PASSWORD      --repo "$REPO" --body "$KEY_PASSWORD"
success "ANDROID_KEY_PASSWORD uploaded"

# ── Summary ───────────────────────────────────────────────────────────────────

echo
success "All secrets uploaded. The build-android.yml workflow is ready."
echo
echo "  To trigger a release build, push a version tag:"
echo "    git tag v0.9.0 && git push origin v0.9.0"
echo
echo "  Or trigger manually via GitHub Actions → Build Android APK → Run workflow."
echo
warn "Keep $KEYSTORE_FILE in a safe place (password manager, encrypted backup)."
warn "It is NOT committed to the repo — GitHub Actions reads it from the secret."
