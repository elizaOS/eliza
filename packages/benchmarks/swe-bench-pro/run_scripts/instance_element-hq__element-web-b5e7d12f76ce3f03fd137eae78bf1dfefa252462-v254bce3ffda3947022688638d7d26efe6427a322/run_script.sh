#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
  export DISPLAY=:99
  
  echo "Running Jest unit tests..."
  yarn test --verbose --passWithNoTests
  
  echo "Running e2e tests..."
  cd /app/test/end-to-end-tests
  
  if [ ! -d "node_modules" ]; then
    ./install.sh
  fi
  
  ./run.sh --app-url http://localhost:8080
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  
  Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
  export DISPLAY=:99
  
  yarn test --verbose --passWithNoTests "${test_files[@]}"
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
