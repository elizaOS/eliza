# Audit Context Building

Build deep architectural context through ultra-granular code analysis before vulnerability hunting.

**Author:** Omar Inuwa

## When to Use

Use this skill when you need to:
- Develop deep comprehension of a codebase before security auditing
- Build bottom-up understanding instead of high-level guessing
- Reduce hallucinations and context loss during complex analysis
- Prepare for threat modeling or architecture review

## What It Does

This skill governs how Claude thinks during the context-building phase of an audit. When active, Claude will:

- Perform **line-by-line / block-by-block** code analysis
- Apply **First Principles**, **5 Whys**, and **5 Hows** at micro scale
- Build and maintain a stable, explicit mental model
- Identify invariants, assumptions, flows, and reasoning hazards
- Track cross-function and external call flows with full context propagation

## Key Principle

This is a **pure context building** skill. It does NOT:
- Identify vulnerabilities
- Propose fixes
- Generate proofs-of-concept
- Assign severity or impact

It exists solely to build deep understanding before the vulnerability-hunting phase.

## Installation

```
/plugin install trailofbits/skills/plugins/audit-context-building
```

## Phases

1. **Initial Orientation** - Map modules, entrypoints, actors, and storage
2. **Ultra-Granular Function Analysis** - Line-by-line semantic analysis with cross-function flow tracking
3. **Global System Understanding** - State/invariant reconstruction, workflow mapping, trust boundaries

## Anti-Hallucination Rules

- Never reshape evidence to fit earlier assumptions
- Update the model explicitly when contradicted
- Avoid vague guesses; use "Unclear; need to inspect X"
- Cross-reference constantly to maintain global coherence

## Related Skills

- `issue-writer` - Write up findings after context is built
- `differential-review` - Uses context-building for baseline analysis
- `spec-compliance` - Compare understood behavior to documentation
