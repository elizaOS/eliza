#!/usr/bin/env bash
# agent-smoke-riscv64.sh
#
# End-to-end Eliza agent-service smoke on a live riscv64 Cuttlefish VM.
# Chains install -> start -> per-modality probes:
#
#   * Readiness: /api/health HTTP 200 (AGENT_HEALTH_HTTP) is the watchdog
#     liveness gate the Android app and ElizaAgentService share.
#   * Llama: tokens emitted >= 32 within a 600s budget.
#   * Kokoro TTS: pulled WAV is a valid RIFF/WAVE PCM file with samples > 0.
#   * Whisper STT: token-overlap vs golden transcript >= 0.80.
#   * Wakeword-cpp: event fires on the wakeword-stimulus fixture.
#   * Silero VAD: agent returns one or more speech segments.
#   * Final: /api/health still 200 and required plugins still status:"ready"
#     (AGENT_STATUS_FINAL_PLUGINS_READY) from the deeper status endpoint.
#
# All assertions are emitted as `KEY=value` markers on stdout and archived
# under packages/chip/docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log
# by capture-aosp-evidence.sh's `cuttlefish-agent-smoke` mode, which this
# script delegates to.
#
# Required env (or flag) inputs:
#   - --aosp / AOSP: path to the AOSP checkout (sourced for adb + envsetup)
#   - --apk / ELIZA_APK_PATH: riscv64 Eliza APK
#   - --llama-model / AOSP_AGENT_LLAMA_MODEL: small GGUF
#   - --golden-audio / AOSP_AGENT_GOLDEN_AUDIO: 10s reference WAV
#   - --golden-transcript / AOSP_AGENT_GOLDEN_TRANSCRIPT: reference text
# Wakeword GGUF + stimulus and VAD fixture fall back to repo-shipped fixtures
# under packages/chip/sw/aosp-device/fixtures/ when not provided explicitly.

set -euo pipefail

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
workspace_root=$(CDPATH=; cd -- "$repo_root/../.." && pwd)
fixtures_dir="$repo_root/sw/aosp-device/fixtures"
capture_driver="$repo_root/sw/aosp-device/capture-aosp-evidence.sh"
install_driver="$repo_root/sw/aosp-device/install-eliza-apk-riscv64.sh"
start_driver="$repo_root/sw/aosp-device/start-eliza-agent-riscv64.sh"
default_apk_rel="packages/app-core/platforms/android/app/build/outputs/apk/release/app-riscv64-release.apk"

usage() {
	cat >&2 <<'USAGE'
usage: agent-smoke-riscv64.sh [options]

Run install -> start -> end-to-end agent smoke against a live CVD and
archive evidence under
packages/chip/docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log.

options:
  --aosp=PATH               AOSP checkout (required by capture-aosp-evidence.sh)
  --apk=PATH                riscv64 Eliza APK (defaults to ELIZA_APK_PATH then
                            workspace_root/<default_apk_rel>)
  --serial=SERIAL           adb serial for the live CVD
  --package=NAME            package name (default: ai.elizaos.app)
  --service=COMPONENT       foreground-service component
                            (default: ai.elizaos.app/.ElizaAgentService)
  --llama-model=PATH        GGUF for the llama smoke (required)
  --golden-audio=PATH       golden STT WAV (required)
  --golden-transcript=TEXT  golden STT transcript text (required)
  --wakeword-model=PATH     wakeword GGUF (default: fixtures/wakeword.gguf)
  --wakeword-audio=PATH     wakeword stimulus WAV
                            (default: fixtures/wakeword-stimulus.wav)
  --vad-audio=PATH          speech+silence WAV
                            (default: fixtures/vad-speech-silence.wav)
  --required-plugins=CSV    plugins that must be status:"ready"
                            (default: local-inference)
  --skip-install            skip install-eliza-apk-riscv64.sh
  --skip-start              skip start-eliza-agent-riscv64.sh
  --help                    this message
USAGE
}

aosp=${AOSP:-${AOSP_DIR:-}}
apk=${ELIZA_APK_PATH:-${AOSP_AGENT_APK:-}}
serial=${AOSP_ADB_SERIAL:-}
package=${AOSP_AGENT_PACKAGE:-ai.elizaos.app}
service=${AOSP_AGENT_SERVICE:-ai.elizaos.app/.ElizaAgentService}
llama_model=${AOSP_AGENT_LLAMA_MODEL:-}
golden_audio=${AOSP_AGENT_GOLDEN_AUDIO:-}
golden_transcript=${AOSP_AGENT_GOLDEN_TRANSCRIPT:-}
wakeword_model=${AOSP_AGENT_WAKEWORD_MODEL:-"$fixtures_dir/wakeword.gguf"}
wakeword_audio=${AOSP_AGENT_WAKEWORD_AUDIO:-"$fixtures_dir/wakeword-stimulus.wav"}
vad_audio=${AOSP_AGENT_VAD_AUDIO:-"$fixtures_dir/vad-speech-silence.wav"}
required_plugins=${AOSP_AGENT_REQUIRED_PLUGINS:-local-inference}
skip_install=0
skip_start=0

while [ "$#" -gt 0 ]; do
	case "$1" in
		--aosp=*) aosp=${1#*=}; shift ;;
		--apk=*) apk=${1#*=}; shift ;;
		--serial=*) serial=${1#*=}; shift ;;
		--package=*) package=${1#*=}; shift ;;
		--service=*) service=${1#*=}; shift ;;
		--llama-model=*) llama_model=${1#*=}; shift ;;
		--golden-audio=*) golden_audio=${1#*=}; shift ;;
		--golden-transcript=*) golden_transcript=${1#*=}; shift ;;
		--wakeword-model=*) wakeword_model=${1#*=}; shift ;;
		--wakeword-audio=*) wakeword_audio=${1#*=}; shift ;;
		--vad-audio=*) vad_audio=${1#*=}; shift ;;
		--required-plugins=*) required_plugins=${1#*=}; shift ;;
		--skip-install) skip_install=1; shift ;;
		--skip-start) skip_start=1; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

if [ -z "$aosp" ]; then
	echo "error: --aosp=PATH (or AOSP env) is required" >&2
	exit 2
fi
if [ ! -f "$aosp/build/envsetup.sh" ]; then
	echo "error: $aosp does not look like an AOSP checkout (missing build/envsetup.sh)" >&2
	exit 1
fi

if [ -z "$apk" ]; then
	apk="$workspace_root/$default_apk_rel"
fi
for required_pair in \
	"APK:$apk" \
	"LLAMA_MODEL:$llama_model" \
	"GOLDEN_AUDIO:$golden_audio"; do
	label=${required_pair%%:*}
	value=${required_pair#*:}
	if [ -z "$value" ]; then
		echo "error: $label is required (flag or env var)" >&2
		exit 2
	fi
	if [ ! -f "$value" ]; then
		echo "error: $label not found: $value" >&2
		exit 1
	fi
done
if [ -z "$golden_transcript" ]; then
	echo "error: --golden-transcript=TEXT (or AOSP_AGENT_GOLDEN_TRANSCRIPT) is required" >&2
	exit 2
fi
for required_pair in \
	"WAKEWORD_MODEL:$wakeword_model" \
	"WAKEWORD_AUDIO:$wakeword_audio" \
	"VAD_AUDIO:$vad_audio"; do
	label=${required_pair%%:*}
	value=${required_pair#*:}
	if [ ! -f "$value" ]; then
		echo "error: $label not found: $value" >&2
		exit 1
	fi
done

log() { printf 'agent-smoke %s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

if [ "$skip_install" -eq 0 ]; then
	log "phase: install"
	"$install_driver" \
		--apk="$apk" \
		${serial:+--serial="$serial"} \
		--package="$package"
else
	log "phase: install (skipped)"
fi

if [ "$skip_start" -eq 0 ]; then
	log "phase: start"
	"$start_driver" \
		${serial:+--serial="$serial"} \
		--package="$package" \
		--service="$service"
else
	log "phase: start (skipped)"
fi

log "phase: smoke (capture-aosp-evidence.sh cuttlefish-agent-smoke)"
export AOSP_ADB_SERIAL=$serial
export AOSP_AGENT_APK=$apk
export AOSP_AGENT_PACKAGE=$package
export AOSP_AGENT_SERVICE=$service
export AOSP_AGENT_LLAMA_MODEL=$llama_model
export AOSP_AGENT_GOLDEN_AUDIO=$golden_audio
export AOSP_AGENT_GOLDEN_TRANSCRIPT=$golden_transcript
export AOSP_AGENT_WAKEWORD_MODEL=$wakeword_model
export AOSP_AGENT_WAKEWORD_AUDIO=$wakeword_audio
export AOSP_AGENT_VAD_AUDIO=$vad_audio
export AOSP_AGENT_REQUIRED_PLUGINS=$required_plugins

exec "$capture_driver" "$aosp" cuttlefish-agent-smoke
