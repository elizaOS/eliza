#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  echo "================= TEST EXECUTION START ================="
  npm test
  echo "================= TEST EXECUTION END ================="
}

run_selected_tests() {
  run_all_tests
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
