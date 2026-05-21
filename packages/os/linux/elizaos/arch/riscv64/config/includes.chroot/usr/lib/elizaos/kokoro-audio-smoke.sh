#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu

SERIAL_CONSOLE="/dev/ttyS0"
MODEL="/opt/elizaos/kokoro/models/kokoro-82m-v1_0.gguf"
VOICE="/opt/elizaos/kokoro/models/voices/af_bella.bin"
KOKORO_TTS="/opt/elizaos/kokoro/bin/kokoro-tts"
OUT="/var/lib/elizaos/hello-eliza.wav"
TEXT="hello, i'm eliza!"

log() {
    printf '[elizaos-kokoro-audio] %s\n' "$*"
}

serial() {
    if [ -w "${SERIAL_CONSOLE}" ]; then
        printf '%s\n' "$*" > "${SERIAL_CONSOLE}" || true
    fi
}

log "starting Kokoro audio smoke"
install -d -o root -g elizaos -m 0750 /var/lib/elizaos

if [ ! -x "${KOKORO_TTS}" ]; then
    log "missing executable: ${KOKORO_TTS}"
    serial "elizaos-kokoro-audio-fail missing-kokoro-tts"
    exit 1
fi
if [ ! -f "${MODEL}" ] || [ ! -f "${VOICE}" ]; then
    log "missing model or voice preset"
    serial "elizaos-kokoro-audio-fail missing-model-assets"
    exit 1
fi

"${KOKORO_TTS}" \
    --model "${MODEL}" \
    --voice "${VOICE}" \
    --text "${TEXT}" \
    --output "${OUT}"

test -s "${OUT}"
serial "elizaos-kokoro-generated path=${OUT}"

aplay -l
aplay "${OUT}"

serial "elizaos-kokoro-audio-ok path=${OUT}"
log "Kokoro audio smoke completed"
