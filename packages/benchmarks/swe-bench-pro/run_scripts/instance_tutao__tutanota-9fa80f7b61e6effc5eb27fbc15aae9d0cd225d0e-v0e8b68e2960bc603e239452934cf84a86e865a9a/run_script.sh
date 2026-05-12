#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  cd /app
  
  export NODE_ICU_DATA=/app/node_modules/full-icu
  
  echo "Running API tests..."
  cd test
  node --icu-data-dir=../node_modules/full-icu test api
  
  echo "Running client tests..."
  node --icu-data-dir=../node_modules/full-icu test client
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
