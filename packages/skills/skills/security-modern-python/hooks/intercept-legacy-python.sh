#!/usr/bin/env bash
set -euo pipefail

# Fast exit if uv not available
command -v uv &>/dev/null || exit 0

# Parse JSON input
input_command=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ -z "$input_command" ]] && exit 0

suggestion=""

# Skip if the command uses uv run (the proper way)
# This handles: uv run python, uv run script.py, etc.
if [[ $input_command =~ (^|[[:space:];|&])uv[[:space:]]+run[[:space:]] ]]; then
  exit 0
fi

# Skip diagnostic commands (checking python location, not executing it)
if [[ $input_command =~ (^|[[:space:];|&])(which|type|whereis)[[:space:]]+(python3?|pip3?)([[:space:]]|$) ]]; then
  exit 0
fi
if [[ $input_command =~ command[[:space:]]+-v[[:space:]]+(python3?|pip3?)([[:space:]]|$) ]]; then
  exit 0
fi

# Skip search tools when python/pip is NOT being executed
# Handles: grep python (OK), python | grep (DENY), find | xargs python (DENY)
if [[ $input_command =~ (^|[[:space:];|&])(grep|rg|ag|ack|find)[[:space:]] ]]; then
  # Check for python/pip at COMMAND position before any pipe
  # Command position: start of string (with optional whitespace) or after ; or &
  before_pipe="${input_command%%|*}"
  py_at_start='^[[:space:]]*(python3?|pip3?)([[:space:]]|$)'
  py_after_sep='[;&][[:space:]]*(python3?|pip3?)([[:space:]]|$)'
  if [[ $before_pipe =~ $py_at_start ]] || [[ $before_pipe =~ $py_after_sep ]]; then
    : # Python executes before pipe - fall through to deny
  # Check for xargs/parallel invoking python/pip after pipe
  elif [[ $input_command == *"|"* ]]; then
    after_pipe="${input_command#*|}"
    if [[ $after_pipe =~ (xargs|parallel)[[:space:]] ]] &&
      [[ $after_pipe =~ (python3?|pip3?)([[:space:]]|$) ]]; then
      : # xargs/parallel invokes python - fall through to deny
    else
      exit 0 # No python execution found
    fi
  else
    exit 0 # No pipe, search tool only - python is just an argument
  fi
fi

# Pattern matching for legacy commands
# Match at: start of line, after ; && || | $( or whitespace
# Captures the matched command (python/python3/pip/pip3) in group 2
legacy_pattern='(^|[;&|]|\$\(|[[:space:]])(python3?|pip3?)([[:space:]]|$)'

if [[ $input_command =~ $legacy_pattern ]]; then
  matched="${BASH_REMATCH[2]}"

  # Determine suggestion based on what was matched
  # Build patterns using the matched command
  # shellcheck disable=SC2016
  case "$matched" in
    python | python3)
      pip_pattern="${matched}[[:space:]]+-m[[:space:]]+pip"
      module_pattern="${matched}[[:space:]]+-m[[:space:]]"
      if [[ $input_command =~ $pip_pattern ]]; then
        suggestion='`python -m pip` -> `uv add`/`uv remove`'
      elif [[ $input_command =~ $module_pattern ]]; then
        suggestion='`python -m module` -> `uv run python -m module`'
      else
        suggestion='`python` -> `uv run python`'
      fi
      ;;
    pip | pip3)
      install_pattern="${matched}[[:space:]]+install"
      uninstall_pattern="${matched}[[:space:]]+uninstall"
      freeze_pattern="${matched}[[:space:]]+freeze"
      if [[ $input_command =~ $install_pattern ]]; then
        suggestion='`pip install` -> `uv add` or `uv run --with pkg`'
      elif [[ $input_command =~ $uninstall_pattern ]]; then
        suggestion='`pip uninstall` -> `uv remove`'
      elif [[ $input_command =~ $freeze_pattern ]]; then
        suggestion='`pip freeze` -> `uv export`'
      else
        suggestion='`pip` -> use `uv` commands instead'
      fi
      ;;
  esac
fi

# Also check for `uv pip` (legacy interface)
uv_pip_pattern='(^|[[:space:];|&])uv[[:space:]]+pip([[:space:]]|$)'
if [[ $input_command =~ $uv_pip_pattern ]]; then
  # shellcheck disable=SC2016
  suggestion='`uv pip` is legacy. Use: `uv add`, `uv remove`, `uv sync`'
fi

[[ -z "$suggestion" ]] && exit 0

# Output denial with suggestion
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use uv instead: ${suggestion}"
  }
}
EOF
