# Spec-to-Code Compliance

Specification-to-code compliance checker for blockchain audits with evidence-based alignment analysis.

**Author:** Omar Inuwa

## When to Use

Use this skill when you need to:
- Verify that code implements exactly what documentation specifies
- Find gaps between intended behavior and actual implementation
- Audit smart contracts against whitepapers or design documents
- Identify undocumented code behavior or unimplemented spec claims

## What It Does

This skill performs deterministic, evidence-based alignment between specifications and code:

- **Documentation Discovery** - Finds all spec sources (whitepapers, READMEs, design notes)
- **Spec Intent Extraction** - Normalizes all intended behavior into structured format
- **Code Behavior Analysis** - Line-by-line semantic analysis of actual implementation
- **Alignment Comparison** - Maps spec items to code with match types and confidence scores
- **Divergence Classification** - Categorizes misalignments by severity (Critical/High/Medium/Low)

## Key Principle

**Zero speculation.** Every claim must be backed by:
- Exact quotes from documentation (section/title)
- Specific code references (file + line numbers)
- Confidence scores (0-1) for all mappings

## Installation

```
/plugin install trailofbits/skills/plugins/spec-to-code-compliance
```

## Phases

1. **Documentation Discovery** - Identify all spec sources
2. **Format Normalization** - Create clean spec corpus
3. **Spec Intent IR** - Extract all intended behavior
4. **Code Behavior IR** - Line-by-line code analysis
5. **Alignment IR** - Compare spec to code
6. **Divergence Classification** - Categorize misalignments
7. **Final Report** - Generate audit-grade compliance report

## Match Types

- `full_match` - Code exactly implements spec
- `partial_match` - Incomplete implementation
- `mismatch` - Spec says X, code does Y
- `missing_in_code` - Spec claim not implemented
- `code_stronger_than_spec` - Code adds behavior
- `code_weaker_than_spec` - Code misses requirements

## Anti-Hallucination Rules

- If spec is silent: classify as **UNDOCUMENTED**
- If code adds behavior: classify as **UNDOCUMENTED CODE PATH**
- If unclear: classify as **AMBIGUOUS**
- Every claim must quote original text or line numbers

## Related Skills

- `context-building` - Deep code understanding
- `issue-writer` - Format compliance gaps as findings
