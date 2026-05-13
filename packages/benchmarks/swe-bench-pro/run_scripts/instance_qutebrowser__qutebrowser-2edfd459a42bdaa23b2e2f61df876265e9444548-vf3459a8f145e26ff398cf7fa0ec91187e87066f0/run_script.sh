#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  export DISPLAY=:99
  export QT_QPA_PLATFORM=offscreen
  export PYTEST_QT_API=pyqt6
  export QUTE_QT_WRAPPER=PyQt6
  export QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"
  
  Xvfb :99 -screen 0 1024x768x24 &
  XVFB_PID=$!
  sleep 2
  
  python3 -m pytest -v tests/unit/api/ tests/unit/utils/ tests/helpers/ --tb=short --continue-on-collection-errors
  
  kill $XVFB_PID 2>/dev/null || true
}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  
  export DISPLAY=:99
  export QT_QPA_PLATFORM=offscreen
  export PYTEST_QT_API=pyqt6
  export QUTE_QT_WRAPPER=PyQt6
  export QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"
  
  Xvfb :99 -screen 0 1024x768x24 &
  XVFB_PID=$!
  sleep 2
  
  python3 -m pytest -v "${test_files[@]}" --tb=short
  
  kill $XVFB_PID 2>/dev/null || true
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
