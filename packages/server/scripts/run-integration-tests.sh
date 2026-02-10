#!/bin/bash
# Radical solution: Run each integration test file in complete isolation
# This ensures PGLite has time to fully shutdown between test files

set -e  # Exit on first failure

# Maximum retries for Bun runtime crashes (segfault, illegal instruction, etc.)
# These are Bun bugs, not test failures, and are transient.
MAX_CRASH_RETRIES=2

echo "🧪 Running integration tests in complete isolation..."
echo "=================================================="

# Automatically find all integration test files
test_files=($(find src/__tests__/integration -name "*.test.ts" -type f | sort))

total_files=${#test_files[@]}
passed=0
failed=0
crashed=0

echo "Found $total_files integration test files"
echo ""

# Check if an exit code indicates a Bun runtime crash (not a test failure).
# - Exit code 1: normal test failure (assertions failed)
# - Exit codes 132 (SIGILL), 134 (SIGABRT), 136 (SIGFPE), 139 (SIGSEGV): runtime crash
# - Exit code 137 (SIGKILL): OOM killer or timeout
is_runtime_crash() {
  local exit_code=$1
  case $exit_code in
    132|134|136|139|137) return 0 ;;  # Crash signals (128 + signal number)
    *) return 1 ;;
  esac
}

for i in "${!test_files[@]}"; do
  file="${test_files[$i]}"
  file_num=$((i + 1))

  echo ""
  echo "[$file_num/$total_files] Running: $(basename $file)"
  echo "---------------------------------------------------"

  # Run test file in isolation, with retry on Bun runtime crashes
  test_passed=false
  attempt=1

  while [ $attempt -le $((MAX_CRASH_RETRIES + 1)) ]; do
    set +e  # Temporarily allow failures so we can capture exit code
    bun test "$file"
    exit_code=$?
    set -e

    if [ $exit_code -eq 0 ]; then
      test_passed=true
      break
    elif is_runtime_crash $exit_code; then
      ((crashed++)) || true
      if [ $attempt -le $MAX_CRASH_RETRIES ]; then
        echo ""
        echo "⚠️  Bun runtime crash detected (exit code $exit_code). Retrying (attempt $((attempt + 1))/$((MAX_CRASH_RETRIES + 1)))..."
        echo "   This is a Bun bug, not a test failure. See: https://bun.sh/docs/project/bugs"
        sleep 3  # Brief cooldown before retry
        ((attempt++))
      else
        echo ""
        echo "⚠️  Bun crashed $((MAX_CRASH_RETRIES + 1)) times on $(basename $file) (exit code $exit_code). Marking as crash-failure."
        break
      fi
    else
      # Normal test failure (exit code 1) -- no retry
      break
    fi
  done

  if $test_passed; then
    echo "✅ PASSED: $(basename $file)"
    ((passed++)) || true
  else
    echo "❌ FAILED: $(basename $file)"
    ((failed++)) || true
  fi

  # Add delay between test files to let PGLite fully shutdown
  # This is the radical solution to PGLite's global state issue
  if [ $file_num -lt $total_files ]; then
    echo ""
    echo "⏳ Waiting 5 seconds for PGLite to fully shutdown..."
    sleep 5
  fi
done

echo ""
echo "=================================================="
echo "🏁 Integration Test Results"
echo "=================================================="
echo "Total files: $total_files"
echo "Passed: $passed"
echo "Failed: $failed"
if [ $crashed -gt 0 ]; then
  echo "Bun crashes: $crashed (retried automatically)"
fi
echo ""

if [ $failed -gt 0 ]; then
  echo "❌ Some tests failed"
  exit 1
else
  echo "✅ All tests passed!"
  exit 0
fi
