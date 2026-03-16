# Semgrep Rule Creator

Create production-quality Semgrep rules for detecting bug patterns and security vulnerabilities.

**Author:** Maciej Domanski

## Skills Included

| Skill                 | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `semgrep-rule-creator` | Guide creation of custom Semgrep rules with testing |

## When to Use

Use this skill when you need to:
- Create custom Semgrep rules for detecting specific bug patterns
- Write rules for security vulnerability detection
- Build taint mode rules for data flow analysis
- Develop pattern matching rules for code quality checks

## What It Does

- Guides test-driven rule development (write tests first, then iterate)
- Analyzes AST structure to help craft precise patterns
- Supports both taint mode (data flow) and pattern matching approaches
- Includes comprehensive reference documentation from Semgrep docs
- Provides common vulnerability patterns by language

## Prerequisites

- [Semgrep](https://semgrep.dev/docs/getting-started/) installed (`pip install semgrep` or `brew install semgrep`)

## Installation

```
/plugin install trailofbits/skills/plugins/semgrep-rule-creator
```

## Related Skills

- `semgrep-rule-variant-creator` - Port existing Semgrep rules to new target languages
- `static-analysis` - General static analysis toolkit with Semgrep, CodeQL, and SARIF parsing
- `variant-analysis` - Find similar vulnerabilities across codebases
