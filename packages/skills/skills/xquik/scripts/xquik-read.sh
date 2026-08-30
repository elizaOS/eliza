#!/bin/sh
# Builds authenticated, read-only Xquik requests from validated CLI arguments.

set -eu

base_url="https://xquik.com/api/v1"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  xquik-read.sh search QUERY [Latest|Top] [LIMIT] [CURSOR]' \
    '  xquik-read.sh tweet TWEET_ID' \
    '  xquik-read.sh thread TWEET_ID [CURSOR]' \
    '  xquik-read.sh user USERNAME_OR_ID' \
    '  xquik-read.sh trends [WOEID] [COUNT]'
}

fail() {
  printf 'xquik-read: %s\n' "$1" >&2
  exit 2
}

require_uint_between() {
  label="$1"
  value="$2"
  minimum="$3"
  maximum="$4"

  case "$value" in
    '' | *[!0-9]*) fail "$label must be an integer from $minimum to $maximum." ;;
  esac

  if [ "$value" -lt "$minimum" ] || [ "$value" -gt "$maximum" ]; then
    fail "$label must be an integer from $minimum to $maximum."
  fi
}

require_tweet_id() {
  tweet_id="$1"
  case "$tweet_id" in
    '' | *[!0-9]*) fail 'Tweet ID must contain 15 to 20 digits.' ;;
  esac

  tweet_id_length=${#tweet_id}
  if [ "$tweet_id_length" -lt 15 ] || [ "$tweet_id_length" -gt 20 ]; then
    fail 'Tweet ID must contain 15 to 20 digits.'
  fi
}

require_user_id() {
  user_id="$1"
  case "$user_id" in
    '' | *[!A-Za-z0-9_]*) fail 'User must be a username without @ or a numeric ID.' ;;
  esac

  if [ "${#user_id}" -gt 32 ]; then
    fail 'User must be a username without @ or a numeric ID.'
  fi
}

request() {
  if [ -z "${XQUIK_API_KEY:-}" ]; then
    fail 'XQUIK_API_KEY is required.'
  fi

  curl \
    --silent \
    --show-error \
    --fail-with-body \
    --proto '=https' \
    --connect-timeout 10 \
    --max-time 30 \
    --header 'accept: application/json' \
    --header "x-api-key: $XQUIK_API_KEY" \
    "$@"
}

command_name="${1:-}"
if [ -z "$command_name" ]; then
  usage >&2
  exit 2
fi
shift

case "$command_name" in
  search)
    [ "$#" -ge 1 ] && [ "$#" -le 4 ] || fail 'Search requires QUERY and accepts TYPE, LIMIT, and CURSOR.'
    query="$1"
    query_type="${2:-Latest}"
    limit="${3:-20}"
    cursor="${4:-}"

    [ -n "$query" ] || fail 'Search query cannot be empty.'
    case "$query_type" in
      Latest | Top) ;;
      *) fail 'Search type must be Latest or Top.' ;;
    esac
    require_uint_between 'Search limit' "$limit" 1 10000

    if [ -n "$cursor" ]; then
      request \
        --get "$base_url/x/tweets/search" \
        --data-urlencode "q=$query" \
        --data-urlencode "queryType=$query_type" \
        --data-urlencode "limit=$limit" \
        --data-urlencode "cursor=$cursor"
    else
      request \
        --get "$base_url/x/tweets/search" \
        --data-urlencode "q=$query" \
        --data-urlencode "queryType=$query_type" \
        --data-urlencode "limit=$limit"
    fi
    ;;
  tweet)
    [ "$#" -eq 1 ] || fail 'Tweet lookup requires one Tweet ID.'
    require_tweet_id "$1"
    request "$base_url/x/tweets/$1"
    ;;
  thread)
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail 'Thread lookup requires a Tweet ID and accepts one cursor.'
    require_tweet_id "$1"
    if [ -n "${2:-}" ]; then
      request \
        --get "$base_url/x/tweets/$1/thread" \
        --data-urlencode "cursor=$2"
    else
      request "$base_url/x/tweets/$1/thread"
    fi
    ;;
  user)
    [ "$#" -eq 1 ] || fail 'User lookup requires one username or ID.'
    require_user_id "$1"
    request "$base_url/x/users/$1"
    ;;
  trends)
    [ "$#" -le 2 ] || fail 'Trends accepts a WOEID and a count.'
    woeid="${1:-1}"
    count="${2:-30}"
    require_uint_between 'WOEID' "$woeid" 1 2147483647
    require_uint_between 'Trend count' "$count" 1 50
    request \
      --get "$base_url/trends" \
      --data-urlencode "woeid=$woeid" \
      --data-urlencode "count=$count"
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    usage >&2
    fail "Unknown command: $command_name"
    ;;
esac
