# Tool Skill Template

Use this template for static analysis tools (Semgrep, CodeQL) and similar standalone CLI tools.

## Template Structure

```markdown
---
name: {tool-name-lowercase}
type: tool
description: >
  {Summary from handbook}. Use when {trigger conditions based on tool purpose}.
---

# {Tool Name}

{Brief introduction from handbook _index.md - 1-2 paragraphs max}

## When to Use

{Decision criteria from handbook "Ideal use case" or similar section}

**Use {Tool Name} when:**
- {Criterion 1}
- {Criterion 2}
- {Criterion 3}

**Consider alternatives when:**
- {Limitation 1} → Consider {Alternative Tool}
- {Limitation 2} → Consider {Alternative Tool}

## Quick Reference

| Task | Command |
|------|---------|
| {Task 1} | `{command 1}` |
| {Task 2} | `{command 2}` |
| {Task 3} | `{command 3}` |

## Installation

{Content from 00-installation.md or installation section}

### Prerequisites

{System requirements}

### Install Steps

{Step-by-step installation - preserve code blocks exactly}

### Verification

\```bash
{Command to verify installation}
\```

## Core Workflow

{Main usage patterns from handbook - the typical workflow}

### Step 1: {First Step}

{Instructions}

### Step 2: {Second Step}

{Instructions}

### Step 3: {Third Step}

{Instructions}

## How to Customize

{Include this section for tools that support custom rules/queries like Semgrep, CodeQL, etc.
Skip this section for simple CLI tools like golint that don't support user-defined rules.}

### Writing Custom {Rules/Queries}

{Basic structure and syntax}

\```{language}
{Template for custom rule/query with comments}
\```

### Key Syntax Reference

| Syntax/Operator | Description | Example |
|-----------------|-------------|---------|
| {Syntax 1} | {What it does} | `{example}` |
| {Syntax 2} | {What it does} | `{example}` |

### Example: {Common Use Case}

{Complete example of a custom rule/query for a realistic use case}

\```{language}
{Full working custom rule/query}
\```

### Testing Custom {Rules/Queries}

{How to validate that custom rules/queries work correctly}

\```bash
{Test command}
\```

## Configuration

{Settings, config files, ignore files}

### Configuration File

{Location and format of main config file}

\```{format}
{Example config file content}
\```

### Ignore Patterns

{How to exclude files/paths - .semgrepignore, .codeqlignore, etc.}

\```
{Example ignore patterns}
\```

### Suppressing False Positives

{How to suppress specific findings inline}

\```{language}
{Example suppression comment}
\```

## Advanced Usage

{Content from 10-advanced.md or advanced section}

### Tips and Tricks

{Practical tips from experienced users - extract from handbook hints/warnings}

| Tip | Why It Helps |
|-----|--------------|
| {Tip 1} | {Explanation} |
| {Tip 2} | {Explanation} |

### {Advanced Topic 1}

{Details}

### {Advanced Topic 2}

{Details}

### Performance Optimization

{How to speed up analysis for large codebases}

\```bash
{Performance-related flags or commands}
\```

## CI/CD Integration

{Content from 20-ci.md if available}

### GitHub Actions

\```yaml
{Example workflow - preserve exactly from handbook}
\```

### Other CI Systems

{General guidance for Jenkins, GitLab CI, etc.}

## Common Mistakes

{Extracted from handbook tips, hints, and warnings}

| Mistake | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| {Mistake 1} | {Reason} | {Fix} |
| {Mistake 2} | {Reason} | {Fix} |

## Limitations

{What the tool cannot do - important for setting expectations}

- **{Limitation 1}:** {Explanation and when this matters}
- **{Limitation 2}:** {Explanation and when this matters}
- **{Limitation 3}:** {Explanation and when this matters}

## Related Skills

{Link to complementary skills - helps discoverability}

| Skill | When to Use Together |
|-------|---------------------|
| **{skill-name-1}** | {Integration scenario - e.g., "For advanced taint tracking beyond intraprocedural"} |
| **{skill-name-2}** | {Integration scenario} |

## Resources

{From 99-resources.md - fetch non-video URLs with WebFetch, extract insights}

### Key External Resources

{For each non-video URL: fetch with WebFetch, summarize key techniques/insights}

**[{Title 1}]({URL})**
{Summarized insights: key techniques, patterns, examples extracted from the page}

**[{Title 2}]({URL})**
{Summarized insights from fetched content}

### Video Resources

{Videos - title and URL only, no fetching}

- [{Video Title}]({YouTube/Vimeo URL}) - {Brief description from handbook}
```

## Field Extraction Guide

| Template Field | Handbook Source |
|----------------|-----------------|
| `{tool-name-lowercase}` | Slugified title from `_index.md` |
| `{Summary from handbook}` | `summary` field from frontmatter |
| `{Tool Name}` | `title` field from frontmatter |
| `{trigger conditions}` | Derive from "Ideal use case" or benefits |
| Quick Reference commands | Extract from code blocks in main content |
| Installation | `00-installation.md` or installation section |
| How to Customize | From custom rules/queries section (if tool supports it) |
| Configuration | From config file documentation |
| Advanced Usage | `10-advanced.md` or advanced section |
| CI/CD Integration | `20-ci.md` if exists |
| Limitations | Extract from "when not to use" or caveats |
| Resources | `99-resources.md` or `91-resources.md` |

## Section Applicability Guide

Not all sections apply to every tool. Use this guide:

| Section | When to Include |
|---------|-----------------|
| How to Customize | Tool supports custom rules/queries (Semgrep, CodeQL, Bandit) |
| Configuration | Tool has config files or significant options |
| CI/CD Integration | Tool is commonly used in CI pipelines |
| Related Skills | Complementary skills exist in the handbook |

## Example: Semgrep

```markdown
---
name: semgrep
type: tool
description: >
  Fast static analysis for finding bugs, detecting vulnerabilities, and enforcing code standards.
  Use when scanning code for security issues, enforcing patterns, or integrating into CI/CD pipelines.
---

# Semgrep

Semgrep is a highly efficient static analysis tool for finding low-complexity bugs and locating
specific code patterns. Because of its ease of use, no need to build the code, and convenient
creation of custom rules, it is usually the first tool to run on an audited codebase.

## When to Use

**Use Semgrep when:**
- Looking for low-complexity bugs with identifiable patterns
- Scanning single files (intraprocedural analysis)
- Detecting systemic bugs across codebase
- Enforcing secure defaults and code standards

**Consider alternatives when:**
- Analysis requires multiple files (cross-file) → Consider CodeQL
- Complex taint tracking is needed → Consider CodeQL
- Need to analyze build artifacts → Consider binary analysis tools

## Quick Reference

| Task | Command |
|------|---------|
| Scan with default rules | `semgrep --config=auto .` |
| Scan with specific rule | `semgrep --config=path/to/rule.yaml .` |
| Output JSON | `semgrep --json --config=auto .` |

## How to Customize

### Writing Custom Rules

Semgrep rules are YAML files with pattern matching. Basic structure:

\```yaml
rules:
  - id: rule-id
    languages: [python]
    message: "Description of the issue: $VAR"
    severity: ERROR
    pattern: dangerous_function($VAR)
\```

### Key Syntax Reference

| Syntax | Description | Example |
|--------|-------------|---------|
| `...` | Match anything | `func(...)` |
| `$VAR` | Capture metavariable | `$FUNC($INPUT)` |
| `<... ...>` | Deep expression match | `<... user_input ...>` |

### Example: SQL Injection Detection

\```yaml
rules:
  - id: sql-injection
    languages: [python]
    message: "Potential SQL injection with user input"
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: cursor.execute($QUERY)
    pattern-sanitizers:
      - pattern: int(...)
\```

### Testing Custom Rules

\```bash
# Create test file with # ruleid: and # ok: annotations
semgrep --test rules/
\```

## Limitations

- **Single-file analysis:** Cannot track data flow across files without Pro
- **No build required:** Cannot analyze compiled code or resolve dynamic dependencies
- **Pattern-based:** May miss vulnerabilities requiring semantic understanding

## Related Skills

| Skill | When to Use Together |
|-------|---------------------|
| **codeql** | For cross-file taint tracking and complex data flow |
| **sarif-parsing** | For processing Semgrep SARIF output in pipelines |

...
```

## Notes

- Keep total lines under 500
- Preserve code blocks exactly from handbook
- Strip Hugo shortcodes (hints, tabs, etc.)
- Fetch non-video external resources with WebFetch, extract key insights
- For videos (YouTube, Vimeo): include title/URL only, do not fetch
- Include "How to Customize" ONLY for tools with extensibility (not simple linters)
- Include "Related Skills" to help users discover complementary tools
- If section doesn't exist in handbook, omit from skill
