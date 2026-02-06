#!/usr/bin/env bats
# Tests for intercept-legacy-python.sh hook

load test_helper

# =============================================================================
# Early Exit Tests
# =============================================================================

@test "exits silently when uv is not available" {
  # Run with restricted PATH that excludes uv
  run_hook_no_uv "python script.py"
  assert_allow
}

@test "exits silently on invalid JSON input" {
  run bash -c 'echo "not json" | '"'$HOOK_SCRIPT'"
  assert_allow
}

@test "exits silently on empty JSON" {
  run bash -c 'echo "{}" | '"'$HOOK_SCRIPT'"
  assert_allow
}

@test "exits silently when command is empty string" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"\"}}" | '"'$HOOK_SCRIPT'"
  assert_allow
}

@test "exits silently when command field is missing" {
  run bash -c 'echo "{\"tool_input\":{}}" | '"'$HOOK_SCRIPT'"
  assert_allow
}

# =============================================================================
# Allow: uv run (proper usage)
# =============================================================================

@test "allows uv run python" {
  run_hook "uv run python script.py"
  assert_allow
}

@test "allows uv run with script directly" {
  run_hook "uv run script.py"
  assert_allow
}

@test "allows uv run python -m module" {
  run_hook "uv run python -m pytest"
  assert_allow
}

@test "allows uv run after semicolon" {
  run_hook "cd project; uv run python script.py"
  assert_allow
}

@test "allows uv run after &&" {
  run_hook "cd project && uv run python script.py"
  assert_allow
}

# =============================================================================
# Allow: Diagnostic Commands
# =============================================================================

@test "allows which python" {
  run_hook "which python"
  assert_allow
}

@test "allows which python3" {
  run_hook "which python3"
  assert_allow
}

@test "allows which pip" {
  run_hook "which pip"
  assert_allow
}

@test "allows which pip3" {
  run_hook "which pip3"
  assert_allow
}

@test "allows type python" {
  run_hook "type python"
  assert_allow
}

@test "allows type python3" {
  run_hook "type python3"
  assert_allow
}

@test "allows whereis python" {
  run_hook "whereis python"
  assert_allow
}

@test "allows whereis pip" {
  run_hook "whereis pip"
  assert_allow
}

@test "allows command -v python" {
  run_hook "command -v python"
  assert_allow
}

@test "allows command -v python3" {
  run_hook "command -v python3"
  assert_allow
}

@test "allows command -v pip" {
  run_hook "command -v pip"
  assert_allow
}

@test "allows command -v pip3" {
  run_hook "command -v pip3"
  assert_allow
}

# =============================================================================
# Allow: Search Tools (python as argument, not command)
# =============================================================================

@test "allows grep python file.txt" {
  run_hook "grep python file.txt"
  assert_allow
}

@test "allows grep -r python src/" {
  run_hook "grep -r python src/"
  assert_allow
}

@test "allows rg python src/" {
  run_hook "rg python src/"
  assert_allow
}

@test "allows ag python ." {
  run_hook "ag python ."
  assert_allow
}

@test "allows ack python" {
  run_hook "ack python"
  assert_allow
}

@test "allows find with python in name pattern" {
  run_hook "find . -name '*.py'"
  assert_allow
}

@test "allows find with python string pattern" {
  run_hook "find . -name 'python*'"
  assert_allow
}

@test "allows grep piped to non-python command" {
  run_hook "grep -l TODO | xargs rm"
  assert_allow
}

@test "allows find piped to grep" {
  run_hook "find . -name '*.py' | grep test"
  assert_allow
}

# =============================================================================
# Deny: Direct Python Execution
# =============================================================================

@test "denies python script.py" {
  run_hook "python script.py"
  assert_deny
  assert_suggestion_contains "uv run python"
}

@test "denies python3 script.py" {
  run_hook "python3 script.py"
  assert_deny
  assert_suggestion_contains "uv run python"
}

@test "denies python -c 'print(1)'" {
  run_hook "python -c 'print(1)'"
  assert_deny
  assert_suggestion_contains "uv run python"
}

@test "denies python3 -m pytest" {
  run_hook "python3 -m pytest"
  assert_deny
  assert_suggestion_contains "uv run python -m module"
}

@test "denies python -m module" {
  run_hook "python -m http.server"
  assert_deny
  assert_suggestion_contains "uv run python -m module"
}

@test "denies python -m pip install" {
  run_hook "python -m pip install requests"
  assert_deny
  assert_suggestion_contains "uv add"
}

@test "denies python3 -m pip install" {
  run_hook "python3 -m pip install requests"
  assert_deny
  assert_suggestion_contains "uv add"
}

# =============================================================================
# Deny: Pip Commands
# =============================================================================

@test "denies pip install" {
  run_hook "pip install requests"
  assert_deny
  assert_suggestion_contains "uv add"
}

@test "denies pip3 install" {
  run_hook "pip3 install requests"
  assert_deny
  assert_suggestion_contains "uv add"
}

@test "denies pip uninstall" {
  run_hook "pip uninstall requests"
  assert_deny
  assert_suggestion_contains "uv remove"
}

@test "denies pip3 uninstall" {
  run_hook "pip3 uninstall foo"
  assert_deny
  assert_suggestion_contains "uv remove"
}

@test "denies pip freeze" {
  run_hook "pip freeze"
  assert_deny
  assert_suggestion_contains "uv export"
}

@test "denies pip3 freeze" {
  run_hook "pip3 freeze"
  assert_deny
  assert_suggestion_contains "uv export"
}

@test "denies pip list" {
  run_hook "pip list"
  assert_deny
  assert_suggestion_contains "uv"
}

@test "denies pip show" {
  run_hook "pip show requests"
  assert_deny
  assert_suggestion_contains "uv"
}

# =============================================================================
# Deny: uv pip (legacy interface)
# =============================================================================

@test "denies uv pip install" {
  run_hook "uv pip install requests"
  assert_deny
  assert_suggestion_contains "uv pip"
  assert_suggestion_contains "legacy"
}

@test "denies uv pip sync" {
  run_hook "uv pip sync requirements.txt"
  assert_deny
  assert_suggestion_contains "uv pip"
  assert_suggestion_contains "legacy"
}

@test "denies uv pip compile" {
  run_hook "uv pip compile requirements.in"
  assert_deny
  assert_suggestion_contains "uv pip"
  assert_suggestion_contains "legacy"
}

@test "denies uv pip freeze" {
  run_hook "uv pip freeze"
  assert_deny
  assert_suggestion_contains "uv pip"
  assert_suggestion_contains "legacy"
}

# =============================================================================
# Deny: Piped Commands with Python Execution
# =============================================================================

@test "denies python3 script.py | grep foo" {
  run_hook "python3 script.py | grep foo"
  assert_deny
}

@test "denies python script.py | head" {
  run_hook "python script.py | head"
  assert_deny
}

@test "denies find | xargs python3" {
  run_hook "find . -name '*.py' | xargs python3"
  assert_deny
}

@test "denies grep | xargs python script.py" {
  run_hook "grep -l test | xargs python script.py"
  assert_deny
}

@test "denies cat file | python3" {
  run_hook "cat file.txt | python3"
  assert_deny
}

@test "denies echo | python -c" {
  run_hook "echo 'data' | python -c 'import sys; print(sys.stdin.read())'"
  assert_deny
}

# =============================================================================
# Deny: Compound Commands
# =============================================================================

@test "denies python after semicolon" {
  run_hook "cd project; python script.py"
  assert_deny
}

@test "denies python after &&" {
  run_hook "cd project && python script.py"
  assert_deny
}

@test "denies python in subshell" {
  run_hook "output=\$(python script.py)"
  assert_deny
}

@test "denies pip after semicolon" {
  run_hook "cd project; pip install requests"
  assert_deny
}

# =============================================================================
# Edge Cases
# =============================================================================

@test "allows command with python in path component" {
  run_hook "cat /usr/bin/python3"
  assert_allow
}

@test "allows ls of python directory" {
  run_hook "ls ~/.python_history"
  assert_allow
}

@test "denies bare python with no args" {
  run_hook "python"
  assert_deny
}

@test "denies bare python3 with no args" {
  run_hook "python3"
  assert_deny
}
