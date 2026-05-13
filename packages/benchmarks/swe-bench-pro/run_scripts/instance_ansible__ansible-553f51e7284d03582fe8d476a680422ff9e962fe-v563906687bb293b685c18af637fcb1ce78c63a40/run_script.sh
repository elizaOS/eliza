#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  cd /app
  export PYTHONPATH="/app/lib:/app/test/lib:$PYTHONPATH"
  
  python bin/ansible-test units --verbose --color no || true
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  cd /app
  export PYTHONPATH="/app/lib:/app/test/lib:$PYTHONPATH"
  
  local test_args=()
  for test in "${test_files[@]}"; do
    local file_path=$(echo "$test" | cut -d':' -f1)
    test_args+=("$file_path")
  done
  
  python bin/ansible-test units --verbose --color no "${test_args[@]}" || true
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
