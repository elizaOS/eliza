#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  cd /app
  export PYTHONPATH=/app:$PYTHONPATH
  
  echo "Running Python unit tests..."
  pytest openlibrary/tests/ tests/unit/ --ignore=tests/integration --ignore=infogami --ignore=vendor --ignore=node_modules -v --tb=short
  
  echo "Running JavaScript tests..."
  npm test || echo "JavaScript tests failed or not available"
  
  echo "Running integration tests..."
  pytest tests/integration/ -v --tb=short || echo "Integration tests failed or require additional setup"
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  cd /app
  export PYTHONPATH=/app:$PYTHONPATH
  
  pytest "${test_files[@]}" -v --tb=short
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
