#!/usr/bin/env bash
# Top-level entry point: capture an AutoFDO profile on a representative
# workload, then run apply + propeller + bolt end-to-end. Used by
# `make autofdo-capture`.
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"

binary="${AUTOFDO_BINARY:-}"
workload="${AUTOFDO_WORKLOAD:-}"
duration="${AUTOFDO_DURATION:-30}"
profile="${AUTOFDO_PROFILE:-build/reports/compiler/autofdo.prof}"

if [ -z "$binary" ] || [ -z "$workload" ]; then
    cat <<EOF
usage: AUTOFDO_BINARY=<elf> AUTOFDO_WORKLOAD=<runner> \\
       AUTOFDO_DURATION=<sec> AUTOFDO_PROFILE=<output.prof> \\
       scripts/run_autofdo_capture.sh

  AUTOFDO_BINARY    target ELF built with -fbasic-block-sections=labels.
  AUTOFDO_WORKLOAD  script that exercises representative paths.
  AUTOFDO_DURATION  seconds to sample (default 30).
  AUTOFDO_PROFILE   output sample profile (default build/reports/compiler/autofdo.prof).
EOF
    echo "STATUS: BLOCKED autofdo.usage"
    exit 2
fi

mkdir -p "$(dirname "$profile")"

compiler/autofdo-harness/capture.sh \
    --binary "$binary" \
    --workload "$workload" \
    --duration "$duration" \
    --output "$profile"

echo "STATUS: PASS autofdo.capture_top"
