#!/usr/bin/env bash
# run_all_bats.sh
# Master script to run all Bats test files in this directory, with summary

set -e

BATS_BIN="$(command -v bats || true)"

if [ -z "$BATS_BIN" ]; then
  echo "[ERROR] 'bats' not found in PATH."
  echo "Please install bats globally using one of the following commands:"
  echo "  npm install -g bats"
  echo "  # or, if you use bun:"
  echo "  bun add -g bats"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ALL_BATS=(test_*.bats)

if [ ${#ALL_BATS[@]} -eq 0 ]; then
  echo "[ERROR] No .bats test files found."
  exit 1
fi

total=0
passed=0
failed=0
FAILED_FILES=()

for bats_file in "${ALL_BATS[@]}"; do
  echo "==================================================="
  echo "[INFO] Running $bats_file"
  if "$BATS_BIN" "$bats_file"; then
    passed=$((passed+1))
  else
    failed=$((failed+1))
    FAILED_FILES+=("$bats_file")
  fi
  total=$((total+1))
  echo "==================================================="
  echo
done

# Summary Table
printf '\n==================== SUMMARY ====================\n'
printf "Total test files: %d\n" "$total"
printf "Passed:          %d\n" "$passed"
printf "Failed:          %d\n" "$failed"

if [ $failed -ne 0 ]; then
  printf "\nFAILED TEST FILES:\n"
  for f in "${FAILED_FILES[@]}"; do
    printf "  - %s\n" "$f"
  done
fi

if [ $failed -eq 0 ]; then
  printf "\nALL TEST SUITES PASSED!\n"
else
  printf "\nSOME TEST SUITES FAILED.\n"
fi

if [ $failed -eq 0 ]; then
  exit 0
else
  exit 1
fi