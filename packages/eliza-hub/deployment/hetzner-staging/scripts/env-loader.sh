#!/usr/bin/env bash

safe_load_env_file() {
  local env_file="$1"
  local allow_env_only="${2:-false}"
  local log_prefix="${3:-env-loader}"

  if [[ ! -f "$env_file" ]]; then
    if [[ "$allow_env_only" == "true" ]]; then
      return 0
    fi
    printf '[%s] error: missing ENV_FILE=%s; set ENV_FILE or ALLOW_ENV_ONLY=true\n' "$log_prefix" "$env_file" >&2
    return 1
  fi

  local line key value line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*(export|source|\.)[[:space:]] ]]; then
      printf '[%s] error: unsupported shell syntax in %s line %s\n' "$log_prefix" "$env_file" "$line_no" >&2
      return 1
    fi

    if [[ ! "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      printf '[%s] error: malformed env assignment in %s line %s\n' "$log_prefix" "$env_file" "$line_no" >&2
      return 1
    fi

    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"

    # shellcheck disable=SC2016
    if [[ "$value" == *'$('* || "$value" == *'`'* ]]; then
      printf '[%s] error: command substitution is not allowed in %s line %s\n' "$log_prefix" "$env_file" "$line_no" >&2
      return 1
    fi

    if [[ "${value:0:1}" == "\"" ]]; then
      if [[ ${#value} -lt 2 || "${value: -1}" != "\"" ]]; then
        printf '[%s] error: unterminated double-quoted value in %s line %s\n' "$log_prefix" "$env_file" "$line_no" >&2
        return 1
      fi
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" ]]; then
      if [[ ${#value} -lt 2 || "${value: -1}" != "'" ]]; then
        printf '[%s] error: unterminated single-quoted value in %s line %s\n' "$log_prefix" "$env_file" "$line_no" >&2
        return 1
      fi
      value="${value:1:${#value}-2}"
    fi

    printf -v "$key" '%s' "$value"
    export "${key?}"
  done < "$env_file"
}
