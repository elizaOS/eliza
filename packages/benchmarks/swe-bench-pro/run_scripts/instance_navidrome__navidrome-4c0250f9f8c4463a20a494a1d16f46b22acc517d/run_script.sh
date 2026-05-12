#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  go test -v ./...
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  local regex_pattern=""
  for test_name in "${test_names[@]}"; do
    if [ -n "$regex_pattern" ]; then
      regex_pattern="${regex_pattern}|${test_name}"
    else
      regex_pattern="${test_name}"
    fi
  done
  
  go test -v -run "^(${regex_pattern})$" ./...
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
