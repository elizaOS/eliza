#!/usr/bin/env bash
# Bootstraps a Gradle wrapper distribution with bounded retries for transient
# HTTP failures from Gradle's official distribution endpoints. The caller's
# exit status is preserved for every other failure so build and configuration
# regressions never receive a second attempt.

set -euo pipefail

readonly DEFAULT_ATTEMPTS=3
readonly DEFAULT_RETRY_DELAY_SECONDS=15

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <gradle-wrapper> [argument...]" >&2
  exit 2
fi

attempts="${GRADLE_WRAPPER_BOOTSTRAP_ATTEMPTS:-$DEFAULT_ATTEMPTS}"
retry_delay_seconds="${GRADLE_WRAPPER_BOOTSTRAP_RETRY_DELAY_SECONDS:-$DEFAULT_RETRY_DELAY_SECONDS}"

case "$attempts" in
  ''|*[!0-9]*|0)
    echo "::error::GRADLE_WRAPPER_BOOTSTRAP_ATTEMPTS must be a positive integer" >&2
    exit 2
    ;;
esac
case "$retry_delay_seconds" in
  ''|*[!0-9]*)
    echo "::error::GRADLE_WRAPPER_BOOTSTRAP_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
    exit 2
    ;;
esac

scratch_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
attempt_log="$(mktemp "${scratch_root%/}/eliza-gradle-wrapper-bootstrap.XXXXXX")"
trap 'rm -f "$attempt_log"' EXIT

is_transient_distribution_failure() {
  grep -Eq \
    'Server returned HTTP response code: (408|425|429|5[0-9][0-9]) for URL: https://(services\.gradle\.org|downloads\.gradle\.org|github\.com/gradle/gradle-distributions)/[^[:space:]]*gradle-[^[:space:]]+\.zip' \
    "$attempt_log"
}

attempt=1
while true; do
  : >"$attempt_log"
  set +e
  "$@" 2>&1 | tee "$attempt_log"
  command_status=${PIPESTATUS[0]}
  set -e

  if [ "$command_status" -eq 0 ]; then
    exit 0
  fi
  if ! is_transient_distribution_failure; then
    exit "$command_status"
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::Gradle wrapper distribution bootstrap failed after ${attempts} attempts" >&2
    exit "$command_status"
  fi

  echo "::warning::Gradle wrapper distribution bootstrap attempt ${attempt}/${attempts} hit a transient HTTP failure; retrying in ${retry_delay_seconds}s" >&2
  sleep "$retry_delay_seconds"
  attempt=$((attempt + 1))
done
