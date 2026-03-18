---
name: semgrep-rule-creator
description: "Create custom Semgrep rules for detecting security vulnerabilities and code patterns. Use when writing new Semgrep YAML rules, defining taint tracking sources/sinks, building pattern-based detections, or creating organization-specific security checks."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Semgrep Rule Creator

## When to Use

- Writing custom Semgrep rules for project-specific vulnerability patterns
- Creating detection rules for internal APIs or frameworks
- Building taint-mode rules to track data flow from sources to sinks
- Porting detection logic from other tools to Semgrep
- Defining coding standards as enforceable rules

## When NOT to Use

- Running existing Semgrep scans (use the semgrep sub-skill in static-analysis)
- Complex interprocedural analysis (use CodeQL for deep data flow)
- Binary or bytecode analysis

## Rule Template

```yaml
rules:
  - id: <org>-<category>-<specific-issue>
    languages: [<language>]
    message: >
      <Clear description of the issue and remediation>
    severity: ERROR  # ERROR | WARNING | INFO
    metadata:
      cwe: "CWE-XXX: Description"
      confidence: HIGH  # HIGH | MEDIUM | LOW
      category: security
    patterns:
      - pattern: <vulnerable-code-pattern>
      - pattern-not: <safe-variant-to-exclude>
```

## Pattern Operators

| Operator | Use Case |
|----------|----------|
| `pattern` | Match exact code structure |
| `patterns` | All must match (AND) |
| `pattern-either` | Any matches (OR) |
| `pattern-not` | Exclude matches |
| `pattern-inside` | Only match within context |
| `pattern-not-inside` | Only match outside context |
| `pattern-regex` | Regex on source text |
| `metavariable-regex` | Regex on captured variable |
| `metavariable-comparison` | Numeric/string comparison |

## Taint Mode Template

```yaml
rules:
  - id: <taint-rule-id>
    languages: [<language>]
    message: "Untrusted data flows to dangerous sink"
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: <source-of-untrusted-data>
    pattern-sinks:
      - pattern: <dangerous-function-call>
    pattern-sanitizers:
      - pattern: <function-that-makes-input-safe>
```

## Testing Rules

Create test files with annotations:
```python
def test_vulnerable():
    # ruleid: my-rule-id
    dangerous_call(user_input)

def test_safe():
    # ok: my-rule-id
    safe_call(sanitized_input)
```

```bash
semgrep --test rules/
```

## Best Practices

1. Use specific, descriptive rule IDs with org prefix
2. Include CWE and confidence metadata
3. Write clear remediation guidance in the message
4. Always create test cases for true positives AND false positives
5. Use `pattern-not` to reduce false positives
6. Prefer `pattern-inside` to limit scope rather than overly complex patterns
7. Test against real codebases before deploying to CI

## Resources

- Rule Syntax — https://semgrep.dev/docs/writing-rules/rule-syntax/
- Playground — https://semgrep.dev/playground
- Rule Registry — https://semgrep.dev/explore
