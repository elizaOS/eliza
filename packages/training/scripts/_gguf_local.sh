#!/usr/bin/env bash
set -uo pipefail
TD=/Users/shawwalters/eliza-workspace/milady/eliza/.claude/worktrees/gpt55-training-pipeline/packages/training
LC=/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-local-inference/native/llama.cpp
CKPT="$TD/checkpoints/eliza1-2b-gpt55scenarios-apollo-1783053000/checkpoint-91"
GGUFDIR="$TD/checkpoints/eliza1-2b-gpt55scenarios-apollo-1783053000/gguf"
VENV="$HOME/.cache/gpt55-venv"
mkdir -p "$GGUFDIR"
echo "[gguf] $(date -u +%H:%M:%S) venv setup"
[ -d "$VENV" ] || uv venv "$VENV" --python 3.12 2>&1 | tail -1
uv pip install --python "$VENV/bin/python" torch numpy safetensors sentencepiece protobuf "gguf>=0.10" transformers accelerate 2>&1 | tail -3
echo "[gguf] $(date -u +%H:%M:%S) convert HF->f16 gguf (vendored gemma-4 converter)"
CONV="$LC/convert_hf_to_gguf.py"
"$VENV/bin/python" "$CONV" "$CKPT" --outfile "$GGUFDIR/eliza-1-2b-gpt55.f16.gguf" --outtype f16 2>&1 | LC_ALL=C tr -cd '[:print:]\n' | tail -8
echo "[gguf] convert exit ${PIPESTATUS[0]}"
if [ -f "$GGUFDIR/eliza-1-2b-gpt55.f16.gguf" ]; then
  echo "[gguf] $(date -u +%H:%M:%S) quantize q4_k_m"
  "$LC/build-desktop-metal/bin/llama-quantize" "$GGUFDIR/eliza-1-2b-gpt55.f16.gguf" "$GGUFDIR/eliza-1-2b-gpt55.q4_k_m.gguf" q4_k_m 2>&1 | tail -3
  echo "[gguf] $(date -u +%H:%M:%S) verify generation"
  "$LC/build-desktop-metal/bin/llama-cli" -m "$GGUFDIR/eliza-1-2b-gpt55.q4_k_m.gguf" -p "The capital of France is" -n 24 -no-cnv --no-warmup 2>/dev/null | LC_ALL=C tr -cd '[:print:]\n' | tail -4
  echo "[gguf] sizes:"; du -h "$GGUFDIR"/*.gguf 2>/dev/null
fi
echo "[gguf] DONE $(date -u +%H:%M:%S)"
