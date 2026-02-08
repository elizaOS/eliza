# Domain Skill Template

Use this template for domain-specific security testing (cryptographic testing, web security methodologies, etc.).

## Template Structure

```markdown
---
name: {domain-name-lowercase}
type: domain
description: >
  {Summary of domain and testing approach}. Use when {trigger conditions}.
---

# {Domain Name}

{Brief introduction to the domain and why specialized testing matters}

## Background

{Theory and context needed to understand this domain}

### Key Concepts

| Concept | Description |
|---------|-------------|
| {Concept 1} | {Explanation} |
| {Concept 2} | {Explanation} |
| {Concept 3} | {Explanation} |

### Why This Matters

{Security implications of getting this wrong - real-world impact}

## When to Use

**Apply this methodology when:**
- {Trigger 1}
- {Trigger 2}
- {Trigger 3}

**Consider alternatives when:**
- {Alternative condition 1}
- {Alternative condition 2}

## Quick Reference

{Decision aid for choosing tools and approaches}

| Scenario | Recommended Approach | Skill |
|----------|---------------------|-------|
| {Scenario 1} | {Approach} | **{skill-name}** |
| {Scenario 2} | {Approach} | **{skill-name}** |
| {Scenario 3} | {Approach} | **{skill-name}** |

## Testing Workflow

{High-level workflow showing how tools and techniques fit together}

\```
Phase 1: {Phase Name}         Phase 2: {Phase Name}
┌─────────────────┐          ┌─────────────────┐
│ {Description}   │    →     │ {Description}   │
│ Tool: {name}    │          │ Tool: {name}    │
└─────────────────┘          └─────────────────┘
         ↓                            ↓
Phase 3: {Phase Name}         Phase 4: {Phase Name}
┌─────────────────┐          ┌─────────────────┐
│ {Description}   │    ←     │ {Description}   │
│ Tool: {name}    │          │ Technique: {n}  │
└─────────────────┘          └─────────────────┘
\```

## Tools and Approaches

{Overview of tools/methods available for this domain}

| Tool/Approach | Purpose | Complexity | Skill |
|---------------|---------|------------|-------|
| {Tool 1} | {Purpose} | {Level} | **{skill-name}** |
| {Tool 2} | {Purpose} | {Level} | **{skill-name}** |
| {Tool 3} | {Purpose} | {Level} | **{skill-name}** |

### {Tool/Approach 1}

{Brief overview of this tool in the domain context}

> **Detailed Guidance:** See the **{tool-skill-name}** skill for installation,
> configuration, and usage details.

#### Quick Start for {Domain}

\```bash
{Domain-specific usage command}
\```

#### Domain-Specific Configuration

\```{format}
{Config specific to this domain use case}
\```

### {Tool/Approach 2}

{Brief overview}

> **Detailed Guidance:** See the **{tool-skill-name}** skill.

#### Quick Start for {Domain}

\```bash
{Domain-specific usage command}
\```

## Key Techniques

{Techniques that apply to this domain - link to technique skills}

| Technique | When to Apply | Skill |
|-----------|---------------|-------|
| {Technique 1} | {When} | **{technique-skill-name}** |
| {Technique 2} | {When} | **{technique-skill-name}** |
| {Technique 3} | {When} | **{technique-skill-name}** |

### Applying {Technique 1} to {Domain}

{How this technique specifically applies to the domain}

> **See Also:** For detailed technique guidance, see the **{technique-skill}** skill.

\```{language}
{Domain-specific example}
\```

## Implementation Guide

{Step-by-step for applying this methodology}

### Phase 1: {First Phase}

{Instructions}

**Tools to use:** {tool-name}, {tool-name}
**Techniques to apply:** {technique-name}

### Phase 2: {Second Phase}

{Instructions}

### Phase 3: {Third Phase}

{Instructions}

## Common Vulnerabilities

{What to look for in this domain}

| Vulnerability | Description | Detection | Severity |
|---------------|-------------|-----------|----------|
| {Vuln 1} | {Description} | {Tool/technique} | {Level} |
| {Vuln 2} | {Description} | {Tool/technique} | {Level} |
| {Vuln 3} | {Description} | {Tool/technique} | {Level} |

### {Vulnerability 1}: Deep Dive

{Detailed explanation of the vulnerability}

**How to detect:**

\```{language}
{Detection code or command}
\```

**Related skill:** **{skill-name}**

## Case Studies

{Real-world examples from handbook}

### Case Study: {Name 1}

{Description of vulnerability and testing approach}

**Tools used:** {tool-list}
**Techniques applied:** {technique-list}

### Case Study: {Name 2}

{Description}

## Advanced Usage

### Tips and Tricks

{Domain-specific tips from experienced practitioners}

| Tip | Why It Helps |
|-----|--------------|
| {Tip 1} | {Explanation} |
| {Tip 2} | {Explanation} |
| {Tip 3} | {Explanation} |

### Common Mistakes

| Mistake | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| {Mistake 1} | {Reason} | {Fix} |
| {Mistake 2} | {Reason} | {Fix} |

## Related Skills

{Comprehensive links to all relevant tools and techniques - KEY for discoverability}

### Tool Skills

{Tools commonly used in this domain}

| Skill | Primary Use in {Domain} |
|-------|-------------------------|
| **{tool-skill-1}** | {How this tool is used in the domain} |
| **{tool-skill-2}** | {How this tool is used in the domain} |
| **{tool-skill-3}** | {How this tool is used in the domain} |

### Technique Skills

{Techniques that apply to this domain}

| Skill | When to Apply |
|-------|---------------|
| **{technique-skill-1}** | {Specific application in this domain} |
| **{technique-skill-2}** | {Specific application in this domain} |
| **{technique-skill-3}** | {Specific application in this domain} |

### Related Domain Skills

{Other domains that share overlap}

| Skill | Relationship |
|-------|--------------|
| **{domain-skill-1}** | {How they relate - e.g., "Crypto testing often overlaps with..."} |
| **{domain-skill-2}** | {How they relate} |

## Skill Dependency Map

{Visual representation of how skills work together in this domain}

\```
                    ┌─────────────────────┐
                    │   {Domain Skill}    │
                    │   (this skill)      │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  {Tool Skill 1} │ │  {Tool Skill 2} │ │  {Tool Skill 3} │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │   Technique Skills       │
              │  {tech-1}, {tech-2}, ... │
              └──────────────────────────┘
\```

## Resources

### Key External Resources

{For each non-video URL: fetch with WebFetch, summarize key insights}

**[{Title 1}]({URL})**
{Summarized insights from fetched content}

**[{Title 2}]({URL})**
{Summarized insights from fetched content}

### Video Resources

{Videos - title and URL only, no fetching}

- [{Video Title}]({YouTube/Vimeo URL}) - {Brief description}
```

## Field Extraction Guide

| Template Field | Handbook Source |
|----------------|-----------------|
| `{domain-name-lowercase}` | Slugified from section name |
| Background | From handbook intro and theory sections |
| Tools and Approaches | From tool subsections |
| Common Vulnerabilities | Extract from handbook or related resources |
| Case Studies | From handbook examples |
| Related Skills | Map to all tool and technique skills in the domain |

## Skill Reference Mapping

When generating a domain skill, map to relevant tool and technique skills:

| Domain | Tool Skills | Technique Skills |
|--------|-------------|------------------|
| Cryptography | wycheproof, constant-time-testing, cryptofuzz | coverage-analysis, property-based-testing |
| Fuzzing (general) | libfuzzer, aflpp, honggfuzz | fuzz-harness-writing, address-sanitizer, coverage-analysis |
| Web Security | semgrep, nuclei | - |
| Static Analysis | semgrep, codeql, bandit | - |

## Example: Cryptographic Testing

```markdown
---
name: crypto-testing
type: domain
description: >
  Methodology for testing cryptographic implementations.
  Use when auditing crypto code, validating implementations, or testing for timing attacks.
---

# Cryptographic Testing

Cryptographic code requires specialized testing beyond standard security scanning.
Subtle bugs in crypto implementations can completely undermine security.

## Background

### Key Concepts

| Concept | Description |
|---------|-------------|
| Test vector | Input/output pair for validating crypto implementation |
| Timing attack | Exploiting execution time variations to extract secrets |
| Constant-time | Code that executes in same time regardless of secret values |

### Why This Matters

Cryptographic bugs can:
- Expose private keys
- Allow signature forgery
- Enable message decryption
- Leak secret values through side channels

## Quick Reference

| Scenario | Recommended Approach | Skill |
|----------|---------------------|-------|
| Validate crypto primitives | Wycheproof test vectors | **wycheproof** |
| Check for timing leaks | Constant-time analysis | **constant-time-testing** |
| Fuzz crypto parsers | Coverage-guided fuzzing | **libfuzzer** |
| Find edge cases | Property-based testing | **property-based-testing** |

## Testing Workflow

\```
Phase 1: Static Analysis      Phase 2: Test Vectors
┌─────────────────┐          ┌─────────────────┐
│ Identify crypto │    →     │ Run Wycheproof  │
│ Tool: semgrep   │          │ Tool: wycheproof│
└─────────────────┘          └─────────────────┘
         ↓                            ↓
Phase 4: Fuzzing              Phase 3: Timing Analysis
┌─────────────────┐          ┌─────────────────┐
│ Edge case bugs  │    ←     │ Side-channel    │
│ Tool: libfuzzer │          │ Tool: CT tools  │
└─────────────────┘          └─────────────────┘
\```

## Tools and Approaches

| Tool/Approach | Purpose | Complexity | Skill |
|---------------|---------|------------|-------|
| Wycheproof | Validate implementations | Low | **wycheproof** |
| Constant-time tools | Detect timing leaks | Medium | **constant-time-testing** |
| libFuzzer | Find edge case bugs | Medium | **libfuzzer** |

### Wycheproof Test Vectors

Test vectors cover ECDSA, RSA, AES-GCM, ECDH, and more.

> **Detailed Guidance:** See the **wycheproof** skill for setup and usage.

#### Quick Start for Crypto Testing

\```bash
git clone https://github.com/google/wycheproof
# See wycheproof skill for integration patterns
\```

### Constant-Time Analysis

Essential for code handling secrets.

> **Detailed Guidance:** See the **constant-time-testing** skill for tools and techniques.

## Common Vulnerabilities

| Vulnerability | Description | Detection | Severity |
|---------------|-------------|-----------|----------|
| Timing side-channel | Execution varies with secrets | constant-time-testing | HIGH |
| Signature malleability | Multiple valid signatures | wycheproof | MEDIUM |
| Invalid curve attack | ECDH with bad points | wycheproof | CRITICAL |

## Related Skills

### Tool Skills

| Skill | Primary Use in Crypto Testing |
|-------|-------------------------------|
| **wycheproof** | Validate implementations against known test vectors |
| **constant-time-testing** | Detect timing side-channels in crypto code |
| **libfuzzer** | Fuzz crypto parsers and edge cases |
| **semgrep** | Find insecure crypto patterns statically |

### Technique Skills

| Skill | When to Apply |
|-------|---------------|
| **coverage-analysis** | Measure test coverage of crypto code |
| **property-based-testing** | Test mathematical properties (e.g., decrypt(encrypt(x)) == x) |
| **fuzz-harness-writing** | Write harnesses for crypto functions |

## Skill Dependency Map

\```
                    ┌─────────────────────┐
                    │   crypto-testing    │
                    │   (this skill)      │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   wycheproof    │ │ constant-time   │ │   libfuzzer     │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │   Technique Skills       │
              │ coverage, harness, PBT   │
              └──────────────────────────┘
\```

...
```

## Example: Web Security Testing

```markdown
---
name: web-security-testing
type: domain
description: >
  Methodology for web application security testing.
  Use when auditing web apps, APIs, or web-based services.
---

# Web Security Testing

...

## Quick Reference

| Scenario | Recommended Approach | Skill |
|----------|---------------------|-------|
| Automated scanning | Nuclei templates | **nuclei** |
| API fuzzing | API-specific tools | **api-fuzzing** |
| Code review | Semgrep rules | **semgrep** |

## Related Skills

### Tool Skills

| Skill | Primary Use in Web Security |
|-------|----------------------------|
| **semgrep** | Find OWASP Top 10 patterns in code |
| **sqlmap** | Automated SQL injection testing |
| **nuclei** | Template-based vulnerability scanning |

### Technique Skills

| Skill | When to Apply |
|-------|---------------|
| **fuzz-harness-writing** | Create harnesses for web parsers |
| **property-based-testing** | Test input validation logic |

...
```

## Notes

- Domain skills often need more background/theory than tool skills
- Include vulnerability patterns specific to the domain
- ALWAYS link to tool skills that implement methodology steps
- ALWAYS link to technique skills that apply to the domain
- Include Quick Reference table mapping scenarios to skills
- Include Skill Dependency Map showing relationships
- Include Testing Workflow showing how skills fit together
- Keep under 500 lines - split into supporting files if needed
- Fetch non-video external resources with WebFetch, extract key insights
- For videos (YouTube, Vimeo): include title/URL only, do not fetch
