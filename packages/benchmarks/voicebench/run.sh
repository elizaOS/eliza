#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
TIMESTAMP=$(python3 -c 'import time; print(int(time.time() * 1000))')
BUN_BIN="${BUN_BIN:-}"
if [[ -z "${BUN_BIN}" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "${ROOT_DIR}/node_modules/.bin/bun" ]]; then
    BUN_BIN="${ROOT_DIR}/node_modules/.bin/bun"
  else
    echo "bun not found. Set BUN_BIN=/path/to/bun or install dependencies so node_modules/.bin/bun exists." >&2
    exit 1
  fi
fi

PROFILE="${VOICEBENCH_PROFILE:-groq}"
ITERATIONS=""
RUN_TS=true
OUT_DIR="${RESULTS_DIR}"
DATASET=""

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --iterations=*) ITERATIONS="${arg#*=}" ;;
    --ts-only) ;;
    --py-only) echo "[voicebench] Python runner removed; use TypeScript only." >&2; exit 1 ;;
    --rs-only) echo "[voicebench] Rust runner removed; use TypeScript only." >&2; exit 1 ;;
    --output-dir=*) OUT_DIR="${arg#*=}" ;;
    --dataset=*) DATASET="${arg#*=}" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

mkdir -p "${OUT_DIR}"

if [[ "${PROFILE}" != "mock" && "${PROFILE}" != "groq" && "${PROFILE}" != "elevenlabs" && "${PROFILE}" != "local-cerebras" && "${PROFILE}" != "local-eliza1" ]]; then
  echo "[voicebench] Unsupported profile: ${PROFILE}. Expected mock, groq, elevenlabs, local-cerebras, or local-eliza1." >&2
  exit 1
fi

if [[ "${PROFILE}" == "mock" ]]; then
  MOCK_OUT="${OUT_DIR}/voicebench-typescript-mock-${TIMESTAMP}.json"
  python3 - "${MOCK_OUT}" "${ITERATIONS:-1}" "${DATASET:-}" <<'PY'
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
try:
    iterations = max(1, int(sys.argv[2] or "1"))
except ValueError:
    iterations = 1
dataset = sys.argv[3] or None
summary = {
    "runs": iterations,
    "avgSpeechEndToTextMs": 0.0,
    "avgTranscriptionMs": 0.0,
    "avgResponseHandlerDecisionMs": 0.0,
    "avgResponseTtftMs": 0.0,
    "avgResponseTotalMs": 0.0,
    "avgSpeechEndToResponseDecisionMs": 0.0,
    "avgSpeechToResponseStartMs": 0.0,
    "avgSpeechEndToFirstAudioUncachedMs": 0.0,
    "avgSpeechEndToFirstAudioCachedMs": 0.0,
    "avgSpeechToVoiceStartUncachedMs": 0.0,
    "avgSpeechToVoiceStartCachedMs": 0.0,
    "avgVoiceGenerationMs": 0.0,
    "avgVoiceFirstTokenUncachedMs": 0.0,
    "avgVoiceFirstTokenCachedMs": 0.0,
    "avgTtsCachedPipelineMs": 0.0,
    "p95SpeechEndToTextMs": 0.0,
    "p99SpeechEndToTextMs": 0.0,
    "p95TranscriptionMs": 0.0,
    "p99TranscriptionMs": 0.0,
    "p95ResponseHandlerDecisionMs": 0.0,
    "p99ResponseHandlerDecisionMs": 0.0,
    "p95ResponseTtftMs": 0.0,
    "p99ResponseTtftMs": 0.0,
    "p95ResponseTotalMs": 0.0,
    "p99ResponseTotalMs": 0.0,
    "p95SpeechToResponseStartMs": 0.0,
    "p99SpeechToResponseStartMs": 0.0,
    "p95SpeechEndToFirstAudioUncachedMs": 0.0,
    "p99SpeechEndToFirstAudioUncachedMs": 0.0,
    "p95SpeechEndToFirstAudioCachedMs": 0.0,
    "p99SpeechEndToFirstAudioCachedMs": 0.0,
    "p95SpeechToVoiceStartUncachedMs": 0.0,
    "p99SpeechToVoiceStartUncachedMs": 0.0,
    "p95SpeechToVoiceStartCachedMs": 0.0,
    "p99SpeechToVoiceStartCachedMs": 0.0,
    "p95VoiceGenerationMs": 0.0,
    "p99VoiceGenerationMs": 0.0,
    "p95VoiceFirstTokenUncachedMs": 0.0,
    "p99VoiceFirstTokenUncachedMs": 0.0,
    "p95VoiceFirstTokenCachedMs": 0.0,
    "p99VoiceFirstTokenCachedMs": 0.0,
    "p95TtsCachedPipelineMs": 0.0,
    "p99TtsCachedPipelineMs": 0.0,
    "firstSentenceCacheHitRate": 1.0,
    "firstSentenceCacheEligibleRate": 1.0,
    "avgTranscriptionWer": 0.0,
    "avgTranscriptionCer": 0.0,
    "transcriptionNormalizedAccuracy": 1.0,
    "avgEndToEndMs": 0.0,
    "p95EndToEndMs": 0.0,
    "p99EndToEndMs": 0.0,
}
payload = {
    "benchmark": "voicebench",
    "runtime": "typescript",
    "profile": "mock",
    "timestamp": out.stem.rsplit("-", 1)[-1],
    "iterations": iterations,
    "datasetName": Path(dataset).stem if dataset else "mock-fixture",
    "datasetPath": dataset,
    "sampleCount": 1,
    "modes": [{"id": "simple", "description": "mock smoke", "benchmarkContext": "mock"}],
    "results": [],
    "summary": {"simple": summary},
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"[voicebench] mock profile wrote {out}")
PY
  echo "[voicebench] done"
  exit 0
fi

# Default Groq model and TTS settings for benchmark consistency.
export GROQ_SMALL_MODEL="${GROQ_SMALL_MODEL:-openai/gpt-oss-120b}"
export GROQ_LARGE_MODEL="${GROQ_LARGE_MODEL:-openai/gpt-oss-120b}"
export GROQ_TRANSCRIPTION_MODEL="${GROQ_TRANSCRIPTION_MODEL:-whisper-large-v3-turbo}"
export GROQ_TTS_MODEL="${GROQ_TTS_MODEL:-canopylabs/orpheus-v1-english}"
export GROQ_TTS_VOICE="${GROQ_TTS_VOICE:-troy}"
export GROQ_TTS_RESPONSE_FORMAT="${GROQ_TTS_RESPONSE_FORMAT:-wav}"

# ElevenLabs low-latency defaults for benchmark parity.
export ELEVENLABS_VOICE_ID="${ELEVENLABS_VOICE_ID:-EXAVITQu4vr4xnSDxMaL}"
export ELEVENLABS_MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_flash_v2_5}"
export ELEVENLABS_OPTIMIZE_STREAMING_LATENCY="${ELEVENLABS_OPTIMIZE_STREAMING_LATENCY:-4}"
export ELEVENLABS_OUTPUT_FORMAT="${ELEVENLABS_OUTPUT_FORMAT:-mp3_22050_32}"

if [[ -z "${VOICEBENCH_AUDIO_PATH:-}" && -z "${DATASET}" ]]; then
  CANDIDATE_AUDIO_PATHS=(
    "${SCRIPT_DIR}/shared/audio/default.wav"
    "${ROOT_DIR}/agent-town/public/assets/background.mp3"
  )
  for candidate in "${CANDIDATE_AUDIO_PATHS[@]}"; do
    if [[ -f "${candidate}" ]]; then
      VOICEBENCH_AUDIO_PATH="${candidate}"
      break
    fi
  done
fi

if [[ ( "${PROFILE}" == "local-cerebras" || "${PROFILE}" == "local-eliza1" ) && -z "${VOICEBENCH_AUDIO_PATH:-}" && -z "${DATASET}" ]]; then
  GENERATED_DIR="${SCRIPT_DIR}/shared/generated"
  GENERATED_DATASET="${GENERATED_DIR}/voiceagentbench-single.json"
  mkdir -p "${GENERATED_DIR}"
  # For local-eliza1 the upstream HF dataset isn't required: synthesize audio
  # from fixture transcripts via macOS `say`.
  if [[ "${PROFILE}" == "local-eliza1" ]]; then
    export VOICEAGENTBENCH_SYNTHESIZE_AUDIO="${VOICEAGENTBENCH_SYNTHESIZE_AUDIO:-1}"
    export VOICEAGENTBENCH_DATA_PATH="${VOICEAGENTBENCH_DATA_PATH:-${ROOT_DIR}/packages/benchmarks/voiceagentbench/fixtures/test_tasks.jsonl}"
  fi
  PYTHONPATH="${ROOT_DIR}/packages/benchmarks/voiceagentbench:${ROOT_DIR}/packages/benchmarks/lifeops-bench:${PYTHONPATH:-}" python3 - "${GENERATED_DIR}" "${GENERATED_DATASET}" <<'PY'
import json
import sys
from pathlib import Path

from elizaos_voiceagentbench.dataset import Suite, load_tasks

out_dir = Path(sys.argv[1])
manifest = Path(sys.argv[2])
tasks = load_tasks(suite_filter=Suite.SINGLE, limit=1)
if not tasks:
    raise SystemExit("VoiceAgentBench did not return any real audio samples")
task = tasks[0]
query = task.queries[0]
if query.audio_bytes is None:
    raise SystemExit(f"VoiceAgentBench task {task.task_id} has no audio bytes")
audio_path = out_dir / f"{task.task_id}.wav"
audio_path.write_bytes(query.audio_bytes)
manifest.write_text(
    json.dumps(
        {
            "datasetName": "voiceagentbench-single-real",
            "samples": [
                {
                    "id": task.task_id,
                    "audioPath": str(audio_path),
                    "expectedText": query.transcript,
                }
            ],
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(manifest)
PY
  DATASET="${GENERATED_DATASET}"
fi

if [[ -z "${VOICEBENCH_AUDIO_PATH:-}" && -z "${DATASET}" ]]; then
  echo "No audio file found. Set VOICEBENCH_AUDIO_PATH to a short audio clip or pass --dataset=manifest.json."
  echo "Mock audio is not accepted by the real benchmark runner."
  exit 1
fi
if [[ -n "${VOICEBENCH_AUDIO_PATH:-}" ]]; then
  VOICEBENCH_AUDIO_PATH="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${VOICEBENCH_AUDIO_PATH}")"
  if [[ ! -f "${VOICEBENCH_AUDIO_PATH}" ]]; then
    echo "Audio file not found: ${VOICEBENCH_AUDIO_PATH}"
    exit 1
  fi
fi

COMMON_ARGS=("--profile=${PROFILE}" "--timestamp=${TIMESTAMP}")
if [[ -n "${VOICEBENCH_AUDIO_PATH:-}" ]]; then
  COMMON_ARGS+=("--audio=${VOICEBENCH_AUDIO_PATH}")
fi
if [[ -n "${ITERATIONS}" ]]; then
  COMMON_ARGS+=("--iterations=${ITERATIONS}")
fi
if [[ -n "${DATASET}" ]]; then
  DATASET="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${DATASET}")"
  if [[ ! -f "${DATASET}" ]]; then
    echo "Dataset manifest not found: ${DATASET}"
    exit 1
  fi
  COMMON_ARGS+=("--dataset=${DATASET}")
fi

if [[ "${PROFILE}" == "local-eliza1" ]]; then
  if [[ -z "${CEREBRAS_API_KEY:-}" ]]; then
    echo "[voicebench] CEREBRAS_API_KEY is required for --profile=local-eliza1." >&2
    exit 1
  fi
  ELIZA1_CLI="${ELIZA1_ASR_CLI:-${ELIZA1_LLAMA_BIN_DIR:-${HOME}/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused}/llama-mtmd-cli}"
  ELIZA1_MODEL="${ELIZA1_ASR_MODEL:-${ELIZA1_ASR_DIR:-${HOME}/.eliza/local-inference/models/eliza-1-2b.bundle/asr}/eliza-1-asr.gguf}"
  ELIZA1_MMPROJ="${ELIZA1_ASR_MMPROJ:-${ELIZA1_ASR_DIR:-${HOME}/.eliza/local-inference/models/eliza-1-2b.bundle/asr}/eliza-1-asr-mmproj.gguf}"
  if [[ ! -x "${ELIZA1_CLI}" || ! -f "${ELIZA1_MODEL}" || ! -f "${ELIZA1_MMPROJ}" ]]; then
    echo "[voicebench] eliza-1 llama-mtmd-cli + ASR model + mmproj are required for --profile=local-eliza1." >&2
    exit 1
  fi
  if [[ ! -x "${VOICEBENCH_SAY_BIN:-/usr/bin/say}" ]]; then
    echo "[voicebench] macOS say is required for --profile=local-eliza1." >&2
    exit 1
  fi
elif [[ "${PROFILE}" == "local-cerebras" ]]; then
  if [[ -z "${CEREBRAS_API_KEY:-}" ]]; then
    echo "[voicebench] CEREBRAS_API_KEY is required for --profile=local-cerebras." >&2
    exit 1
  fi
  if ! python3 - <<'PY'
import importlib.util
raise SystemExit(0 if importlib.util.find_spec("faster_whisper") else 1)
PY
  then
    echo "[voicebench] faster-whisper is required for --profile=local-cerebras." >&2
    exit 1
  fi
  if [[ ! -x "${VOICEBENCH_SAY_BIN:-/usr/bin/say}" ]]; then
    echo "[voicebench] macOS say is required for --profile=local-cerebras." >&2
    exit 1
  fi
elif [[ -z "${GROQ_API_KEY:-}" ]]; then
  echo "[voicebench] GROQ_API_KEY is required for real response/STT profile ${PROFILE}." >&2
  exit 1
fi
if [[ "${PROFILE}" == "elevenlabs" && -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "[voicebench] ELEVENLABS_API_KEY is required for --profile=elevenlabs." >&2
  exit 1
fi

echo "[voicebench] profile=${PROFILE}"
if [[ -n "${VOICEBENCH_AUDIO_PATH:-}" ]]; then
  echo "[voicebench] audio=${VOICEBENCH_AUDIO_PATH}"
fi
if [[ -n "${DATASET}" ]]; then
  echo "[voicebench] dataset=${DATASET}"
fi
echo "[voicebench] groq-large-model=${GROQ_LARGE_MODEL}"
echo "[voicebench] groq-transcription-model=${GROQ_TRANSCRIPTION_MODEL}"
echo "[voicebench] groq-tts-model=${GROQ_TTS_MODEL} voice=${GROQ_TTS_VOICE} format=${GROQ_TTS_RESPONSE_FORMAT}"
echo "[voicebench] elevenlabs-model=${ELEVENLABS_MODEL_ID} voice=${ELEVENLABS_VOICE_ID} latency=${ELEVENLABS_OPTIMIZE_STREAMING_LATENCY} format=${ELEVENLABS_OUTPUT_FORMAT}"
if [[ "${PROFILE}" == "local-cerebras" ]]; then
  echo "[voicebench] local-cerebras-model=${CEREBRAS_MODEL:-gpt-oss-120b}"
  echo "[voicebench] local-stt=faster-whisper model=${VOICEBENCH_FASTER_WHISPER_MODEL:-tiny.en}"
  echo "[voicebench] local-tts=${VOICEBENCH_SAY_BIN:-/usr/bin/say}"
fi
if [[ "${PROFILE}" == "local-eliza1" ]]; then
  echo "[voicebench] local-eliza1-model=${CEREBRAS_MODEL:-gpt-oss-120b}"
  echo "[voicebench] local-stt=eliza-1-asr (llama-mtmd-cli)"
  echo "[voicebench] local-tts=${VOICEBENCH_SAY_BIN:-/usr/bin/say}"
fi

if $RUN_TS; then
  echo "[voicebench] TypeScript"
  TS_OUT="${OUT_DIR}/voicebench-typescript-${PROFILE}-${TIMESTAMP}.json"
  (cd "${ROOT_DIR}" && "${BUN_BIN}" run "${SCRIPT_DIR}/typescript/src/bench.ts" "${COMMON_ARGS[@]}" "--output=${TS_OUT}")
  echo "  -> ${TS_OUT}"
fi

echo "[voicebench] done"
