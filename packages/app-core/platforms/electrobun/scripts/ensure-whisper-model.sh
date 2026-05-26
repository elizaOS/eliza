#!/usr/bin/env bash
set -euo pipefail

model="${1:-base.en}"
whisper_pkg="${WHISPER_NODE_PACKAGE_DIR:-}"

if [ -z "$whisper_pkg" ]; then
  whisper_pkg="$(node -e 'const { createRequire } = require("node:module"); const path = require("node:path"); const req = createRequire(process.cwd() + "/"); console.log(path.dirname(req.resolve("whisper-node/package.json")));')"
fi

models_dir="$whisper_pkg/lib/whisper.cpp/models"
model_file="$models_dir/ggml-$model.bin"
cache_dir="${MILADY_WHISPER_MODEL_CACHE_DIR:-}"
cache_file=""

if [ -n "$cache_dir" ]; then
  cache_file="$cache_dir/ggml-$model.bin"
fi

if [ -n "$cache_file" ] && [ -f "$cache_file" ]; then
  mkdir -p "$models_dir"
  cp "$cache_file" "$model_file"
  exit 0
fi

if [ -f "$model_file" ]; then
  exit 0
fi

bash "$models_dir/download-ggml-model.sh" "$model"

if [ -n "$cache_file" ]; then
  mkdir -p "$cache_dir"
  cp "$model_file" "$cache_file"
fi
