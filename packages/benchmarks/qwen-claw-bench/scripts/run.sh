#!/usr/bin/env bash
# Run QwenClawBench tasks in batch with Docker concurrency
# Usage: ./scripts/run.sh --model dashscope/qwen3.6-plus --concurrency 10
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
exec python scripts/benchmark.py "$@"
