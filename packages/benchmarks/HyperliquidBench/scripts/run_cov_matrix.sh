#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/run_cov_matrix.sh [TASK ...] [-- <hl-runner args>]

Runs `scripts/run_cov.sh` across every plan line in the supplied task files.
If no TASK arguments are provided, all files under dataset/tasks/*.jsonl are
used. Arguments after `--` are forwarded verbatim to `scripts/run_cov.sh` (and
therefore `hl-runner`).

Environment variables honoured (same as run_cov.sh):
  OUT_DIR        base directory for run outputs (default: runs/<timestamp>)
  NETWORK        network flag passed to hl-runner (default: testnet)
  DOMAINS_FILE   domains config path (default: dataset/domains-hl.yaml)
USAGE
}

TASKS=()
FORWARD=()
PARSE_FORWARD=false

for arg in "$@"; do
  if ${PARSE_FORWARD}; then
    FORWARD+=("$arg")
    continue
  fi
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --)
      PARSE_FORWARD=true
      ;;
    *)
      TASKS+=("$arg")
      ;;
  esac
done

if [[ ${#TASKS[@]} -eq 0 ]]; then
  mapfile -t TASKS < <(ls dataset/tasks/*.jsonl 2>/dev/null | sort)
fi

if [[ ${#TASKS[@]} -eq 0 ]]; then
  echo "no task files found" >&2
  exit 1
fi

for task in "${TASKS[@]}"; do
  if [[ ! -f "$task" ]]; then
    echo "skipping missing task file: $task" >&2
    continue
  fi
  total=$(rg -c '.' "$task" 2>/dev/null || true)
  if [[ -z "$total" || "$total" -eq 0 ]]; then
    echo "no scenarios in $task" >&2
    continue
  fi
  for ((idx=1; idx<=total; idx++)); do
    echo "==> Running $task:$idx"
    if [[ ${#FORWARD[@]} -gt 0 ]]; then
      scripts/run_cov.sh "$task:$idx" -- "${FORWARD[@]}"
    else
      scripts/run_cov.sh "$task:$idx"
    fi
  done
done
