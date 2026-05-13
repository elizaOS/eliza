#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  export CI=true
  export NODE_ENV=test
  
  mkdir -p /tmp/test_results
  
  echo "Running Jest unit tests..."
  timeout 600 yarn test --verbose --passWithNoTests --testTimeout=30000 2>&1 || echo "Jest tests completed with code $?"
  
  echo "Running Playwright e2e tests..."
  if [ -d "playwright" ]; then
    yarn global add serve
    yarn build
    npx serve -p 8080 -s ./lib &
    SERVER_PID=$!
    
    sleep 15
    
    timeout 300 yarn test:playwright --reporter=line --timeout=30000 2>&1 || echo "Playwright tests completed with code $?"
    
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  else
    echo "No Playwright tests found"
  fi
  

}

run_selected_tests() {
  local test_files=("$@")
  echo "Running selected tests: ${test_files[@]}"
  
  export CI=true
  export NODE_ENV=test
  
  mkdir -p /tmp/test_results
  
  for file in "${test_files[@]}"; do
    if [[ $file == *"playwright"* ]] || [[ $file == *"e2e"* ]]; then
      echo "Running Playwright test: $file"
      yarn global add serve
      yarn build
      npx serve -p 8080 -s ./lib &
      SERVER_PID=$!
      sleep 15
      timeout 300 yarn test:playwright --reporter=line "$file" 2>&1 || echo "Test completed with code $?"
      kill $SERVER_PID 2>/dev/null || true
      wait $SERVER_PID 2>/dev/null || true
    else
      echo "Running Jest test: $file"
      yarn test --verbose --testPathPattern="$file" --passWithNoTests 2>&1 || echo "Test completed with code $?"
    fi
  done
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
