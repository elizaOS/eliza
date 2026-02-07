# Variant Analysis

Find similar vulnerabilities and bugs across codebases using pattern-based analysis.

**Author:** Axel Mierczuk

## When to Use

Use this skill when you need to:
- Hunt for bug variants after finding an initial vulnerability
- Build CodeQL or Semgrep queries from a known bug pattern
- Perform systematic code audits across large codebases
- Analyze security vulnerabilities and find similar instances
- Create reusable patterns for recurring vulnerability classes

## What It Does

This skill provides a systematic five-step process for variant analysis:
1. **Understand the original issue** - Identify root cause, conditions, and exploitability
2. **Create an exact match** - Start with a pattern matching only the known bug
3. **Identify abstraction points** - Determine what can be generalized
4. **Iteratively generalize** - Expand patterns one element at a time
5. **Analyze and triage** - Document and prioritize findings

Includes:
- Tool selection guidance (ripgrep, Semgrep, CodeQL)
- Critical pitfalls to avoid (narrow scope, over-specific patterns)
- Ready-to-use templates for CodeQL and Semgrep in Python, JavaScript, Java, Go, and C++
- Detailed methodology documentation

## Installation

```
/plugin install trailofbits/skills/plugins/variant-analysis
```

## Related Skills

- `codeql` - Primary tool for deep interprocedural variant analysis
- `semgrep` - Fast pattern matching for simpler variants
- `sarif-parsing` - Process variant analysis results
