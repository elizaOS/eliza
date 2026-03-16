# Semgrep Rule Variant Creator

A Claude Code skill for porting existing Semgrep rules to new target languages with proper applicability analysis and test-driven validation.

## Overview

This skill takes an existing Semgrep rule and one or more target languages, then generates independent rule variants for each applicable language. Each variant goes through a complete 4-phase cycle:

1. **Applicability Analysis** - Determine if the vulnerability pattern applies to the target language
2. **Test Creation** - Write test-first with vulnerable and safe cases
3. **Rule Creation** - Translate patterns and adapt for target language idioms
4. **Validation** - Ensure all tests pass before proceeding

## Prerequisites

- [Semgrep](https://semgrep.dev/docs/getting-started/) installed and available in PATH
- Existing Semgrep rule to port (in YAML)
- Target languages specified

## Usage

Invoke the skill when you want to port an existing Semgrep rule:

```
Port the sql-injection.yaml Semgrep rule to Go and Java
```

```
Create Semgrep rule variants of my-rule.yaml for TypeScript, Rust, and C#
```

```
Create the same Semgrep rule for JavaScript and Ruby
```

```
Port this Semgrep rule to Golang
```

## Output Structure

For each applicable target language, the skill produces:

```
<original-rule-id>-<language>/
├── <original-rule-id>-<language>.yaml     # Ported rule
└── <original-rule-id>-<language>.<ext>    # Test file
```

## Example

**Input:**
- Rule: `python-command-injection.yaml`
- Target languages: Go, Java

**Output:**
```
python-command-injection-golang/
├── python-command-injection-golang.yaml
└── python-command-injection-golang.go

python-command-injection-java/
├── python-command-injection-java.yaml
└── python-command-injection-java.java
```

## Key Differences from semgrep-rule-creator

| Aspect | semgrep-rule-creator | semgrep-rule-variant-creator |
|--------|---------------------|------------------------------|
| Input | Bug pattern description | Existing rule + target languages |
| Output | Single rule+test | Multiple rule+test directories |
| Workflow | Single creation cycle | Independent cycle per language |
| Phase 1 | Problem analysis | Applicability analysis |

## Skill Files

- `skills/semgrep-rule-variant-creator/SKILL.md` - Main entry point
- `skills/semgrep-rule-variant-creator/references/applicability-analysis.md` - Phase 1 guidance
- `skills/semgrep-rule-variant-creator/references/language-syntax-guide.md` - Pattern translation guidance
- `skills/semgrep-rule-variant-creator/references/workflow.md` - Detailed 4-phase workflow

## Related Skills

- **semgrep-rule-creator** - Create new Semgrep rules from scratch
- **static-analysis** - Run existing Semgrep rules against code
