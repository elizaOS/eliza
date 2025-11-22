#!/bin/bash
# Radical solution: Run each integration test file in complete isolation
# This ensures PGLite has time to fully shutdown between test files

set -e  # Exit on first failure

echo "🧪 Running integration tests in complete isolation..."
echo "=================================================="

# Automatically find all integration test files
test_files=($(find src/__tests__/integration -name "*.test.ts" -type f | sort))

total_files=${#test_files[@]}
passed=0
failed=0

echo "Found $total_files integration test files"
echo ""

for i in "${!test_files[@]}"; do
  file="${test_files[$i]}"
  file_num=$((i + 1))

  echo ""
  echo "[$file_num/$total_files] Running: $(basename $file)"
  echo "---------------------------------------------------"

  # Run test file in isolation
  if bun test "$file"; then
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
echo ""

if [ $failed -gt 0 ]; then
  echo "❌ Some tests failed"
  exit 1
else
  echo "✅ All tests passed!"
  exit 0
fi
