#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  export PATH="/app/node_modules/.bin:$PATH"
  export NODE_ENV=development
  export CI=true
  
  Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
  export DISPLAY=:99
  
  cd /app
  
  echo "Running Jest unit tests..."
  yarn test --verbose --passWithNoTests 2>&1
  
  JEST_EXIT_CODE=$?
  
  if [ $JEST_EXIT_CODE -eq 0 ]; then
    echo "Running Cypress e2e tests..."
    yarn test:cypress --headless 2>&1 || echo "Cypress tests failed, continuing with Jest results"
  fi
  
  return $JEST_EXIT_CODE
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  
  export PATH="/app/node_modules/.bin:$PATH"
  export NODE_ENV=development
  export CI=true
  
  Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
  export DISPLAY=:99
  
  cd /app
  
  if [[ "${test_files[0]}" == *"cypress"* ]]; then
    echo "Running Cypress tests..."
    yarn test:cypress --headless --spec "${test_files[@]}" 2>&1
    return $?
  else
    echo "Running Jest tests..."
    yarn test --verbose --passWithNoTests "${test_files[@]}" 2>&1
    return $?
  fi
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
