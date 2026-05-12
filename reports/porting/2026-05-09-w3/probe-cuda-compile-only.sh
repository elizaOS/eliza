#!/usr/bin/env bash
# probe-cuda-compile-only.sh
# Drive a per-.cu compile-only PTX emit pass against the elizaOS/llama.cpp
# CUDA backend, for every arch in CUDA_ARCHS. Run AFTER a successful
# `cmake --build build-cuda --target ggml-cuda` so includes_CUDA.rsp exists.
#
# Output: $OUT_DIR/probe-summary.tsv with columns
#   relative_cu_path \t status(OK|FAIL) \t ptx_bytes_or_zero \t exit_code
#   plus per-failure logs at $OUT_DIR/fail/<flat>.log
#
# Reads:
#   FORK_DIR (default /home/shaw/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0)
#   BUILD_DIR (default $FORK_DIR/build-cuda)
#   CUDA_HOME (default /home/shaw/cuda)
#   CUDA_ARCHS (default "80;86;89;90")
#   OUT_DIR (default ./cuda-compile-only-probe)
#
# Exits 0 if every file compiled, 1 otherwise.

set -uo pipefail

FORK_DIR="${FORK_DIR:-/home/shaw/.cache/eliza-android-agent/eliza-llama-cpp-v0.1.0}"
BUILD_DIR="${BUILD_DIR:-$FORK_DIR/build-cuda}"
CUDA_HOME="${CUDA_HOME:-/home/shaw/cuda}"
CUDA_ARCHS="${CUDA_ARCHS:-80;86;89;90}"
OUT_DIR="${OUT_DIR:-./cuda-compile-only-probe}"
NVCC="$CUDA_HOME/bin/nvcc"
RSP="$BUILD_DIR/ggml/src/ggml-cuda/CMakeFiles/ggml-cuda.dir/includes_CUDA.rsp"

mkdir -p "$OUT_DIR/fail" "$OUT_DIR/ptx"
SUMMARY="$OUT_DIR/probe-summary.tsv"
: > "$SUMMARY"

if [ ! -x "$NVCC" ]; then
  echo "[probe] nvcc not found at $NVCC" >&2
  exit 2
fi
if [ ! -f "$RSP" ]; then
  echo "[probe] includes RSP not found at $RSP - build the ggml-cuda target first" >&2
  exit 2
fi

# nvcc -ptx requires a single -arch (it cannot emit fatbins to PTX). We
# loop per arch, emitting one .ptx per (file, arch) pair. A failure on
# any arch fails that row; we record which arch broke it in the summary.
IFS=';' read -ra ARCH_LIST <<< "$CUDA_ARCHS"

cd "$FORK_DIR"

mapfile -t CU_FILES < <(find ggml/src/ggml-cuda -name '*.cu' | sort)

total="${#CU_FILES[@]}"
ok=0
fail=0
i=0

echo "[probe] $total .cu files x ${#ARCH_LIST[@]} archs (${CUDA_ARCHS}) = $((total * ${#ARCH_LIST[@]})) compiles"

for cu in "${CU_FILES[@]}"; do
  i=$((i+1))
  flat="${cu//\//_}"; flat="${flat%.cu}"
  log="$OUT_DIR/fail/${flat}.log"
  : > "$log"

  file_ok=true
  total_sz=0
  for a in "${ARCH_LIST[@]}"; do
    num="${a%%[!0-9]*}"
    ptx="$OUT_DIR/ptx/${flat}-sm${num}.ptx"
    out=$("$NVCC" -ptx \
      --options-file "$RSP" \
      -DGGML_CUDA_FA_ALL_QUANTS -DGGML_CUDA_PEER_MAX_BATCH_SIZE=128 \
      -DGGML_CUDA_USE_GRAPHS -DGGML_SCHED_MAX_COPIES=4 \
      -O3 -DNDEBUG -std=c++17 \
      --generate-code=arch=compute_${num},code=compute_${num} \
      -Xcompiler=-fPIC \
      -use_fast_math \
      -extended-lambda \
      -Wno-deprecated-gpu-targets \
      -x cu "$cu" -o "$ptx" 2>&1)
    rc=$?
    if [ $rc -eq 0 ] && [ -s "$ptx" ]; then
      sz=$(wc -c < "$ptx")
      total_sz=$((total_sz + sz))
    else
      file_ok=false
      printf '=== sm_%s rc=%s ===\n%s\n' "$num" "$rc" "$out" >> "$log"
    fi
  done

  if $file_ok; then
    printf '%s\tOK\t%s\t0\n' "$cu" "$total_sz" >> "$SUMMARY"
    ok=$((ok+1))
    rm -f "$log"
  else
    printf '%s\tFAIL\t0\t1\n' "$cu" >> "$SUMMARY"
    fail=$((fail+1))
  fi

  if [ $((i % 10)) -eq 0 ]; then
    echo "[probe] $i / $total  ok=$ok  fail=$fail"
  fi
done

echo "[probe] DONE  total=$total  ok=$ok  fail=$fail  summary=$SUMMARY"

if [ $fail -gt 0 ]; then
  exit 1
fi
exit 0
