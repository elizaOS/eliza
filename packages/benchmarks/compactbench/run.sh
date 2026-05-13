#!/usr/bin/env bash
#
# Run CompactBench against the elizaOS TypeScript compactors.
#
# Required env:
#   CEREBRAS_API_KEY  — Cerebras inference API key (gpt-oss-120b judge)
#
# Optional env:
#   COMPACTBENCH_GROQ_API_KEY — fallback if Cerebras provider can't register
#   COMPACT_METHOD            — override the method class/spec
#                               (default: NaiveSummaryCompactor). Use
#                               HermesNativeToolCompactor for the Hermes
#                               native tool-call adapter, or pass an explicit
#                               <file.py>:<ClassName> spec.
#   COMPACT_SUITE             — override the suite (default: elite_practice)
#   COMPACTBENCH_BENCHMARKS_DIR — directory containing the public suites
#                                (default: ./external/compactbench-suites/benchmarks/public)
#
# CompactBench v0.1.0 is a Python package only — the public suite YAMLs live
# in the upstream git repo, not on PyPI. The first run clones them into
# ./external/compactbench-suites if the directory is missing.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ -z "${CEREBRAS_API_KEY:-}" ]]; then
  echo "error: CEREBRAS_API_KEY is not set." >&2
  echo "       Set it to your Cerebras inference key before running." >&2
  exit 1
fi

# 1. Editable install (idempotent).
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e ".[dev]"
python -m pip install --quiet -e "../hermes-adapter"

# 2. Pull the public benchmark suites if not already present.
SUITES_REPO_DIR="${HERE}/external/compactbench-suites"
BENCHMARKS_DIR="${COMPACTBENCH_BENCHMARKS_DIR:-${SUITES_REPO_DIR}/benchmarks/public}"
if [[ ! -d "$BENCHMARKS_DIR" ]]; then
  mkdir -p "$(dirname "$SUITES_REPO_DIR")"
  echo "[run.sh] cloning compactbench suites -> $SUITES_REPO_DIR"
  git clone --depth 1 https://github.com/compactbench/compactbench.git "$SUITES_REPO_DIR"
fi

# 3. Try to register the Cerebras provider.
PROVIDER_FLAG=$(python - <<'PY'
import sys
try:
    from eliza_compactbench.cerebras_provider import register_cerebras_provider
except Exception:
    print("groq", end="")
    sys.exit(0)

ok = register_cerebras_provider()
print("cerebras" if ok else "groq", end="")
PY
)

# 4. Resolve method. CompactBench's resolver wants <file.py>:<ClassName>.
METHOD_CLASS="${COMPACT_METHOD:-NaiveSummaryCompactor}"
if [[ "$METHOD_CLASS" == *":"* ]]; then
  METHOD_SPEC="$METHOD_CLASS"
elif [[ "$METHOD_CLASS" == "HermesNativeToolCompactor" ]]; then
  METHOD_SPEC="${HERE}/hermes_compactbench/compactors.py:${METHOD_CLASS}"
else
  METHOD_SPEC="${HERE}/eliza_compactbench/compactors/__init__.py:${METHOD_CLASS}"
fi
SUITE="${COMPACT_SUITE:-elite_practice}"
RESULTS_DIR="${HERE}/results"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="${RESULTS_DIR}/results.$(date +%Y%m%d-%H%M%S).jsonl"

echo "[run.sh] provider=${PROVIDER_FLAG} method=${METHOD_SPEC} suite=${SUITE}"
echo "[run.sh] benchmarks-dir=${BENCHMARKS_DIR}"
echo "[run.sh] results -> ${RESULTS_FILE}"

if [[ "$PROVIDER_FLAG" == "cerebras" ]]; then
  compactbench run \
    --method "${METHOD_SPEC}" \
    --suite "$SUITE" \
    --provider cerebras \
    --model gpt-oss-120b \
    --benchmarks-dir "$BENCHMARKS_DIR" \
    --output "$RESULTS_FILE"
else
  if [[ -z "${COMPACTBENCH_GROQ_API_KEY:-}" ]]; then
    echo "error: Cerebras provider could not register and COMPACTBENCH_GROQ_API_KEY is not set." >&2
    exit 1
  fi
  echo "[run.sh] cerebras provider not registerable; falling back to groq" >&2
  compactbench run \
    --method "${METHOD_SPEC}" \
    --suite "$SUITE" \
    --provider groq \
    --model llama-3.1-8b-instant \
    --benchmarks-dir "$BENCHMARKS_DIR" \
    --output "$RESULTS_FILE"
fi

echo
echo "[run.sh] scoring..."
compactbench score --results "$RESULTS_FILE"
