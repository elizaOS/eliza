#!/usr/bin/env bash
# run_all_bats.sh
# Master script to run all Bats test files in this directory, with summary

set -e

BATS_BIN="$(command -v bats || true)"
if [ -z "$BATS_BIN" ]; then
  echo "[INFO] 'bats' not found in PATH. Attempting to help you install bats-core..."
  unameOut="$(uname -s)"
  case "$unameOut" in
    Darwin*)
      echo "[INFO] Detected macOS. Installing bats-core via Homebrew..."
      if command -v brew >/dev/null 2>&1; then
        brew install bats-core || { echo '[ERROR] Failed to install bats-core via Homebrew.'; exit 1; }
      else
        echo '[ERROR] Homebrew not found. Please install Homebrew and rerun, or install bats-core manually: https://github.com/bats-core/bats-core' ; exit 1
      fi
      ;;
    Linux*)
      echo "[INFO] Detected Linux. Installing bats via apt-get (sudo required)..."
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y bats || { echo '[ERROR] Failed to install bats via apt-get.'; exit 1; }
      else
        echo '[ERROR] apt-get not found. Please install bats manually: https://github.com/bats-core/bats-core' ; exit 1
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo '[ERROR] Windows detected. Please follow manual install instructions: https://github.com/bats-core/bats-core' ; exit 1
      ;;
    *)
      echo '[ERROR] Unknown OS. Please install bats-core manually: https://github.com/bats-core/bats-core' ; exit 1
      ;;
  esac
  BATS_BIN="$(command -v bats || true)"
  if [ -z "$BATS_BIN" ]; then
    echo "[ERROR] bats still not found after attempted install. Please install bats-core manually."
    exit 1
  fi
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