---
name: semgrep
description: Run Semgrep static analysis for fast security scanning and pattern matching. Use when asked to scan code with Semgrep, write custom YAML rules, find vulnerabilities quickly, use taint mode, or set up Semgrep in CI/CD pipelines.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Semgrep Static Analysis

## When to Use Semgrep

**Ideal scenarios:**
- Quick security scans (minutes, not hours)
- Pattern-based bug detection
- Enforcing coding standards and best practices
- Finding known vulnerability patterns
- Single-file analysis without complex data flow
- First-pass analysis before deeper tools

**Consider CodeQL instead when:**
- Need interprocedural taint tracking across files
- Complex data flow analysis required
- Analyzing custom proprietary frameworks

## When NOT to Use

Do NOT use this skill for:
- Complex interprocedural data flow analysis (use CodeQL instead)
- Binary analysis or compiled code without source
- Custom deep semantic analysis requiring AST/CFG traversal
- When you need to track taint across many function boundaries

## Installation

```bash
# pip
python3 -m pip install semgrep

# Homebrew
brew install semgrep

# Docker
docker run --rm -v "${PWD}:/src" returntocorp/semgrep semgrep --config auto /src

# Update
pip install --upgrade semgrep
```

## Core Workflow

### 1. Quick Scan

```bash
semgrep --config auto .                    # Auto-detect rules
semgrep --config auto --metrics=off .      # Disable telemetry for proprietary code
```

### 2. Use Rulesets

```bash
semgrep --config p/<RULESET> .             # Single ruleset
semgrep --config p/security-audit --config p/trailofbits .  # Multiple
```

| Ruleset | Description |
|---------|-------------|
| `p/default` | General security and code quality |
| `p/security-audit` | Comprehensive security rules |
| `p/owasp-top-ten` | OWASP Top 10 vulnerabilities |
| `p/cwe-top-25` | CWE Top 25 vulnerabilities |
| `p/r2c-security-audit` | r2c security audit rules |
| `p/trailofbits` | Trail of Bits security rules |
| `p/python` | Python-specific |
| `p/javascript` | JavaScript-specific |
| `p/golang` | Go-specific |

### 3. Output Formats

```bash
semgrep --config p/security-audit --sarif -o results.sarif .   # SARIF
semgrep --config p/security-audit --json -o results.json .     # JSON
semgrep --config p/security-audit --dataflow-traces .          # Show data flow
```

### 4. Scan Specific Paths

```bash
semgrep --config p/python app.py           # Single file
semgrep --config p/javascript src/         # Directory
semgrep --config auto --include='**/test/**' .  # Include tests (excluded by default)
```

## Writing Custom Rules

### Basic Structure

```yaml
rules:
  - id: hardcoded-password
    languages: [python]
    message: "Hardcoded password detected: $PASSWORD"
    severity: ERROR
    pattern: password = "$PASSWORD"
```

### Pattern Syntax

| Syntax | Description | Example |
|--------|-------------|---------|
| `...` | Match anything | `func(...)` |
| `$VAR` | Capture metavariable | `$FUNC($INPUT)` |
| `<... ...>` | Deep expression match | `<... user_input ...>` |

### Pattern Operators

| Operator | Description |
|----------|-------------|
| `pattern` | Match exact pattern |
| `patterns` | All must match (AND) |
| `pattern-either` | Any matches (OR) |
| `pattern-not` | Exclude matches |
| `pattern-inside` | Match only inside context |
| `pattern-not-inside` | Match only outside context |
| `pattern-regex` | Regex matching |
| `metavariable-regex` | Regex on captured value |
| `metavariable-comparison` | Compare values |

### Combining Patterns

```yaml
rules:
  - id: sql-injection
    languages: [python]
    message: "Potential SQL injection"
    severity: ERROR
    patterns:
      - pattern-either:
          - pattern: cursor.execute($QUERY)
          - pattern: db.execute($QUERY)
      - pattern-not:
          - pattern: cursor.execute("...", (...))
      - metavariable-regex:
          metavariable: $QUERY
          regex: .*\+.*|.*\.format\(.*|.*%.*
```

### Taint Mode (Data Flow)

Simple pattern matching finds obvious cases:

```python
# Pattern `os.system($CMD)` catches this:
os.system(user_input)  # Found
```

But misses indirect flows:

```python
# Same pattern misses this:
cmd = user_input
processed = cmd.strip()
os.system(processed)  # Missed - no direct match
```

Taint mode tracks data through assignments and transformations:
- **Source**: Where untrusted data enters (`user_input`)
- **Propagators**: How it flows (`cmd = ...`, `processed = ...`)
- **Sanitizers**: What makes it safe (`shlex.quote()`)
- **Sink**: Where it becomes dangerous (`os.system()`)

```yaml
rules:
  - id: command-injection
    languages: [python]
    message: "User input flows to command execution"
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: request.args.get(...)
      - pattern: request.form[...]
      - pattern: request.json
    pattern-sinks:
      - pattern: os.system($SINK)
      - pattern: subprocess.call($SINK, shell=True)
      - pattern: subprocess.run($SINK, shell=True, ...)
    pattern-sanitizers:
      - pattern: shlex.quote(...)
      - pattern: int(...)
```

### Full Rule with Metadata

```yaml
rules:
  - id: flask-sql-injection
    languages: [python]
    message: "SQL injection: user input flows to query without parameterization"
    severity: ERROR
    metadata:
      cwe: "CWE-89: SQL Injection"
      owasp: "A03:2021 - Injection"
      confidence: HIGH
    mode: taint
    pattern-sources:
      - pattern: request.args.get(...)
      - pattern: request.form[...]
      - pattern: request.json
    pattern-sinks:
      - pattern: cursor.execute($QUERY)
      - pattern: db.execute($QUERY)
    pattern-sanitizers:
      - pattern: int(...)
    fix: cursor.execute($QUERY, (params,))
```

## Testing Rules

### Test File Format

```python
# test_rule.py
def test_vulnerable():
    user_input = request.args.get("id")
    # ruleid: flask-sql-injection
    cursor.execute("SELECT * FROM users WHERE id = " + user_input)

def test_safe():
    user_input = request.args.get("id")
    # ok: flask-sql-injection
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_input,))
```

```bash
semgrep --test rules/
```

## CI/CD Integration (GitHub Actions)

```yaml
name: Semgrep

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 0 1 * *'  # Monthly

jobs:
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: returntocorp/semgrep

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for diff-aware scanning

      - name: Run Semgrep
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            semgrep ci --baseline-commit ${{ github.event.pull_request.base.sha }}
          else
            semgrep ci
          fi
        env:
          SEMGREP_RULES: >-
            p/security-audit
            p/owasp-top-ten
            p/trailofbits
```

## Configuration

### .semgrepignore

```
tests/fixtures/
**/testdata/
generated/
vendor/
node_modules/
```

### Suppress False Positives

```python
password = get_from_vault()  # nosemgrep: hardcoded-password
dangerous_but_safe()  # nosemgrep
```

## Performance

```bash
semgrep --config rules/ --time .    # Check rule performance
ulimit -n 4096                       # Increase file descriptors for large codebases
```

### Path Filtering in Rules

```yaml
rules:
  - id: my-rule
    paths:
      include: [src/]
      exclude: [src/generated/]
```

## Third-Party Rules

```bash
pip install semgrep-rules-manager
semgrep-rules-manager --dir ~/semgrep-rules download
semgrep -f ~/semgrep-rules .
```

## Rationalizations to Reject

| Shortcut | Why It's Wrong |
|----------|----------------|
| "Semgrep found nothing, code is clean" | Semgrep is pattern-based; it can't track complex data flow across functions |
| "I wrote a rule, so we're covered" | Rules need testing with `semgrep --test`; false negatives are silent |
| "Taint mode catches injection" | Only if you defined all sources, sinks, AND sanitizers correctly |
| "Pro rules are comprehensive" | Pro rules are good but not exhaustive; supplement with custom rules for your codebase |
| "Too many findings = noisy tool" | High finding count often means real problems; tune rules, don't disable them |

## Resources

- Registry: https://semgrep.dev/explore
- Playground: https://semgrep.dev/playground
- Docs: https://semgrep.dev/docs/
- Trail of Bits Rules: https://github.com/trailofbits/semgrep-rules
- Blog: https://semgrep.dev/blog/
