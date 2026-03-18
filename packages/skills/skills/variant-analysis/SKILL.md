---
name: variant-analysis
description: "Find variants of known vulnerabilities across a codebase. Use when a vulnerability has been found and you need to search for similar patterns elsewhere, when performing systematic variant hunting after a security advisory, or when generalizing a specific bug into a broader detection query."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Variant Analysis

## When to Use

- A vulnerability was found and you need to check for similar patterns elsewhere
- A security advisory describes a bug class and you need to assess exposure
- Generalizing a specific bug fix into a broader detection rule
- Systematic sweep after a security incident to find related issues
- Building detection queries from a known vulnerability exemplar

## When NOT to Use

- Initial discovery of novel vulnerability classes (use fuzzing or audit)
- Exact-match searching for a known CVE (just grep for the affected function)
- Runtime detection (use WAF or RASP)

## Variant Analysis Workflow

### 1. Understand the Original Bug
- What is the root cause? (missing check, wrong type, logic error)
- What makes it exploitable? (untrusted input reaches vulnerable code)
- What is the minimal pattern that captures the essence?

### 2. Generalize the Pattern
- Abstract away specific variable names and values
- Identify the structural pattern (e.g., "unchecked cast after deserialization")
- Consider language-specific variations of the same concept

### 3. Search for Variants

```bash
# Grep for structural patterns
grep -rn "cast.*deserialize\|fromJson.*\.(int\|long)" --include="*.java" .

# Semgrep for semantic patterns
semgrep --config /path/to/variant-rule.yaml .

# CodeQL for deep data flow variants
codeql database analyze db variant-query.ql
```

### 4. Triage Results
- Confirm each match is actually reachable with untrusted input
- Assess exploitability (is there a viable attack path?)
- Prioritize by severity and exposure

### 5. Create Persistent Detection
- Write Semgrep/CodeQL rules to catch future instances
- Add to CI pipeline to prevent regressions
- Document the variant class for team awareness

## Generalization Strategies

| Original Bug | Generalized Pattern |
|-------------|-------------------|
| SQL injection in `getUserById` | Any string concatenation in SQL query methods |
| XSS in `renderComment` | Any user input in HTML template without escaping |
| Path traversal in `downloadFile` | Any user input in filesystem path construction |
| Buffer overflow in `parseHeader` | Any unbounded copy from network input |
| Missing auth check in `/api/admin` | Any route handler without auth middleware |

## Tools for Variant Analysis

| Tool | Strength | Best For |
|------|----------|----------|
| Semgrep | Fast pattern matching | Single-file structural variants |
| CodeQL | Deep data flow | Cross-function/file variants |
| grep/ripgrep | Quick text search | Simple string pattern variants |
| AST-grep | Structural code search | Language-aware structural matching |

## Anti-Patterns

| Mistake | Problem |
|---------|---------|
| Only searching exact strings | Misses renamed or refactored variants |
| Ignoring different languages | Same bug class can exist in JS, Python, Go, etc. |
| Stopping at first match | Variant analysis requires exhaustive search |
| Not creating detection rules | Same variant will reappear in new code |
