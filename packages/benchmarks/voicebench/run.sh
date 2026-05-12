#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
TIMESTAMP=$(python3 -c 'import time; print(int(time.time() * 1000))')

PROFILE="${VOICEBENCH_PROFILE:-mock}"
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

if [[ -z "${VOICEBENCH_AUDIO_PATH:-}" ]]; then
  CANDIDATE_AUDIO_PATHS=(
    "${SCRIPT_DIR}/shared/audio/default.wav"
    "${ROOT_DIR}/agent-town/public/assets/background.mp3"
  )
  if [[ "${PROFILE}" == "mock" ]]; then
    CANDIDATE_AUDIO_PATHS=("${SCRIPT_DIR}/shared/mock-audio.txt" "${CANDIDATE_AUDIO_PATHS[@]}")
  fi

  for candidate in "${CANDIDATE_AUDIO_PATHS[@]}"; do
    if [[ -f "${candidate}" ]]; then
      VOICEBENCH_AUDIO_PATH="${candidate}"
      break
    fi
  done
fi

if [[ -z "${VOICEBENCH_AUDIO_PATH:-}" ]]; then
  echo "No audio file found. Set VOICEBENCH_AUDIO_PATH to a short audio clip."
  echo "For credential-free smoke tests, use --profile=mock."
  exit 1
fi
VOICEBENCH_AUDIO_PATH="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${VOICEBENCH_AUDIO_PATH}")"
if [[ ! -f "${VOICEBENCH_AUDIO_PATH}" ]]; then
  echo "Audio file not found: ${VOICEBENCH_AUDIO_PATH}"
  exit 1
fi

COMMON_ARGS=("--profile=${PROFILE}" "--audio=${VOICEBENCH_AUDIO_PATH}" "--timestamp=${TIMESTAMP}")
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

echo "[voicebench] profile=${PROFILE}"
echo "[voicebench] audio=${VOICEBENCH_AUDIO_PATH}"
if [[ -n "${DATASET}" ]]; then
  echo "[voicebench] dataset=${DATASET}"
fi
echo "[voicebench] groq-large-model=${GROQ_LARGE_MODEL}"
echo "[voicebench] groq-transcription-model=${GROQ_TRANSCRIPTION_MODEL}"
echo "[voicebench] groq-tts-model=${GROQ_TTS_MODEL} voice=${GROQ_TTS_VOICE} format=${GROQ_TTS_RESPONSE_FORMAT}"
echo "[voicebench] elevenlabs-model=${ELEVENLABS_MODEL_ID} voice=${ELEVENLABS_VOICE_ID} latency=${ELEVENLABS_OPTIMIZE_STREAMING_LATENCY} format=${ELEVENLABS_OUTPUT_FORMAT}"

if $RUN_TS; then
  echo "[voicebench] TypeScript"
  TS_OUT="${OUT_DIR}/voicebench-typescript-${PROFILE}-${TIMESTAMP}.json"
  (cd "${ROOT_DIR}" && bun run "${SCRIPT_DIR}/typescript/src/bench.ts" "${COMMON_ARGS[@]}" "--output=${TS_OUT}")
  echo "  -> ${TS_OUT}"
fi

echo "[voicebench] done"
