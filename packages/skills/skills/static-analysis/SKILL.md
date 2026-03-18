---
name: static-analysis
description: "Static analysis toolkit with CodeQL, Semgrep, and SARIF parsing for security vulnerability detection. Use when running static analysis scans, writing custom detection rules, or processing analysis results."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Static Analysis

Comprehensive static analysis toolkit for security vulnerability detection, based on the [Trail of Bits Application Security Testing Handbook](https://appsec.guide/).

## When to Use

- Running security scans on codebases (any language)
- Writing custom CodeQL queries or Semgrep rules
- Processing and triaging SARIF output files from analysis tools
- Setting up static analysis in CI/CD pipelines
- Comparing and aggregating results from multiple tools

## When NOT to Use

- Building brand-new detection workflows outside this toolkit's CodeQL, Semgrep, and SARIF scope
- Dynamic analysis or fuzzing (use testing-handbook-skills)
- Smart contract auditing or chain-specific review work

## Sub-Skills

| Tool | Purpose | Best For | Skill Path |
|------|---------|----------|------------|
| **CodeQL** | Semantic code analysis with database queries | Deep data flow tracking, taint analysis, cross-function analysis | [skills/codeql/SKILL.md](skills/codeql/SKILL.md) |
| **Semgrep** | Fast pattern-matching static analysis | Quick scans, custom rules, CI integration, lightweight checks | [skills/semgrep/SKILL.md](skills/semgrep/SKILL.md) |
| **SARIF Parsing** | Parse and process SARIF result files | Aggregating results, CI/CD integration, multi-tool triage | [skills/sarif-parsing/SKILL.md](skills/sarif-parsing/SKILL.md) |

## Tool Selection Guide

| Scenario | Recommended Tool |
|----------|-----------------|
| Quick security scan | Semgrep |
| Deep vulnerability analysis | CodeQL |
| Data flow / taint tracking | CodeQL (best) or Semgrep taint mode |
| Custom pattern detection | Semgrep (simpler) or CodeQL (more powerful) |
| CI/CD integration | Semgrep (fastest) + CodeQL (thorough) |
| Processing scan results | SARIF Parsing |
| Non-building codebase | Semgrep (works on incomplete code) |

## Quick Start

### Semgrep (fast scan)
```bash
# Install
pip install semgrep

# Run with recommended rulesets
semgrep --config=auto .

# Run specific ruleset
semgrep --config=p/security-audit .
```

### CodeQL (deep analysis)
```bash
# Create database
codeql database create mydb --language=python --source-root=.

# Run security queries
codeql database analyze mydb codeql/python-queries:codeql-suites/python-security-extended.qls --format=sarif-latest --output=results.sarif
```

### SARIF Processing
```bash
# Parse results with jq
jq '.runs[].results[] | {ruleId, message: .message.text, location: .locations[0].physicalLocation.artifactLocation.uri}' results.sarif
```

## Workflow

1. **Quick scan** with Semgrep for fast results
2. **Deep analysis** with CodeQL for thorough coverage
3. **Aggregate results** using SARIF parsing
4. **Triage findings** by severity and exploitability
5. **Custom rules** for project-specific patterns

## Related Skills

- **testing-handbook-skills** - Pair static analysis with fuzzing, sanitizers, and coverage-driven testing
