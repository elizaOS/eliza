# Agent Prompt Template

Use this prompt when spawning each skill generation agent. Variables in `{braces}` are substituted from the per-skill package (see [discovery.md](discovery.md#phase-3-prepare-generation-context)).

---

# Skill Generation Task

Generate: **{name}** (type: {type}, pass: {pass})

## Context

You are generating a Claude Code skill as a sibling to testing-handbook-generator:
```
plugins/testing-handbook-skills/skills/
├── testing-handbook-generator/   # This generator (do not modify)
├── {name}/                       # ← Your output directory
│   └── SKILL.md                  # ← Write here
├── libfuzzer/                    # Example sibling
└── semgrep/                      # Example sibling
```

## Inputs

| Variable | Value |
|----------|-------|
| Handbook section | `{handbook_path}/content/docs/{section_path}/` |
| Template | `{template_path}` |
| Related sections | `{related_sections}` |
| Pass | `{pass}` (1=content generation, 2=cross-references only) |

**Notes:**
- `related_sections` is a comma-separated list of handbook paths (e.g., `fuzzing/techniques/asan, fuzzing/techniques/harness`), or empty string if none.
- `pass` determines what to generate: Pass 1 generates all content except Related Skills; Pass 2 only populates Related Skills.

## Process

### Pass 1: Content Generation

1. **Read template first** - defines all required sections
2. **Read ALL `*.md` files** in the handbook section path
3. **Read related sections** (if `related_sections` is not empty) for context
4. **Fetch external resources** with these limits:
   - Maximum **5 URLs** per skill (prioritize official docs over blogs)
   - Skip video URLs (YouTube, Vimeo, etc.) - include title/URL only
   - **30 second timeout** per fetch - skip and note in warnings if timeout
5. **Check line count** - if content will exceed 450 lines, apply splitting rules (see below)
6. **Validate before writing** (see checklist below)
7. **Write SKILL.md** with Related Skills placeholder:
   ```markdown
   ## Related Skills

   <!-- PASS2: populate after all skills exist -->
   ```

### Pass 2: Cross-Reference Population (run after all Pass 1 complete)

1. **List generated skills**: Read all `skills/*/SKILL.md` files to get skill names
2. **Determine related skills** for this skill based on:
   - `related_sections` mapping (handbook structure → skill names)
   - Skill type relationships (e.g., fuzzers typically relate to technique skills)
   - Explicit mentions in the skill's content
3. **Replace the placeholder** with actual Related Skills section
4. **Validate** that all referenced skills exist

## Pre-Write Validation Checklist

### Pass 1 Checklist

Before writing SKILL.md, verify ALL items:

- [ ] **Line count**: Content will be under 500 lines (if >450, apply splitting rules)
- [ ] **No shortcodes**: No `{{<` or `{{% ` patterns remain in output
- [ ] **No escaped backticks**: No `\``` ` patterns remain (should be unescaped to ` ``` `)
- [ ] **Required section**: Has `## When to Use` heading
- [ ] **Trigger phrase**: Description contains "Use when" or "Use for"
- [ ] **Code preserved**: All code blocks have language specifier and exact content
- [ ] **Related Skills placeholder**: Has `## Related Skills` with `<!-- PASS2: ... -->` comment

If any check fails, fix before writing. If unfixable (e.g., source has no code), note in warnings.

### Pass 2 Checklist

Before updating Related Skills section:

- [ ] **All referenced skills exist**: Each skill name in Related Skills has a corresponding `skills/{name}/SKILL.md`
- [ ] **No circular-only references**: Don't list only skills that reference this skill back
- [ ] **Appropriate skill types**: Fuzzers link to techniques; techniques link to tools/fuzzers

## Critical Rules

**Template backtick escaping:**

Templates use `\``` ` (backslash-escaped backticks) to show code block examples within markdown code blocks. When generating skills:
- Convert `\``` ` → ` ``` ` (remove the backslash escape)
- This applies to all code fence markers in the "Template Structure" sections
- Example: `\```bash` in template becomes ` ```bash` in generated skill

**Hugo shortcode conversion:**

| From | To |
|------|-----|
| `{{< hint info >}}X{{< /hint >}}` | `> **Note:** X` |
| `{{< hint warning >}}X{{< /hint >}}` | `> **Warning:** X` |
| `{{< hint danger >}}X{{< /hint >}}` | `> **⚠️ Danger:** X` |
| `{{< tabs >}}{{< tab "Y" >}}X{{< /tab >}}{{< /tabs >}}` | `### Y` followed by X |
| `{{% relref "path" %}}` | `See: path` (plain text) |
| `{{< customFigure "..." >}}` | `(See handbook diagram)` |
| `{{< mermaid >}}X{{< /mermaid >}}` | Omit (describe diagram in text if critical) |
| `{{< details "title" >}}X{{< /details >}}` | `<details><summary>title</summary>X</details>` |
| `{{< expand "title" >}}X{{< /expand >}}` | `<details><summary>title</summary>X</details>` |
| `{{< figure src="..." >}}` | `(See handbook image: filename)` |
| `{{< youtube ID >}}` | `[Video: Title](https://youtube.com/watch?v=ID)` (title only) |
| `{{< vimeo ID >}}` | `[Video: Title](https://vimeo.com/ID)` (title only) |
| `{{< button href="URL" >}}X{{< /button >}}` | `[X](URL)` |
| `{{< columns >}}X{{< /columns >}}` | Remove wrapper, keep content X |
| `{{< katex >}}X{{< /katex >}}` | `$X$` (inline math) or omit if complex |

**Preserve exactly:** Code blocks (language specifier, indentation, full content)

**Omit:** Images (reference as: `See handbook diagram: filename.svg`), video content (title/URL only)

**YAML frontmatter:**
- `name`: lowercase, `[a-z0-9-]+`, max 64 chars
- `type`: one of `tool`, `fuzzer`, `technique`, `domain` (determines required sections)
- `description`: max 1024 chars, MUST include "Use when {trigger}" or "Use for {purpose}"

## Error Handling

| Situation | Action |
|-----------|--------|
| Missing handbook content | Note gap in report, use template placeholder |
| WebFetch timeout (>30s) | Include URL without summary, note in warnings |
| WebFetch fails | Include URL without summary, note in warnings |
| Over 450 lines in draft | Apply Line Count Splitting Rules (see below) |
| Missing resources file | Omit Resources section, note in report |
| No related sections (`related_sections` is empty) | Leave Related Skills placeholder for Pass 2 |

## Line Count Splitting Rules

**Hard limit:** 500 lines per file. **Soft limit:** 450 lines (triggers splitting).

### When to Split

After drafting content, count lines. If **line count > 450**:

1. **Identify split candidates** (sections that can stand alone):

   | Section | Split Priority | Typical Lines |
   |---------|---------------|---------------|
   | Installation | High | 50-100 |
   | Advanced Usage | High | 80-150 |
   | CI/CD Integration | High | 60-100 |
   | Troubleshooting | Medium | 40-80 |
   | Configuration | Medium | 50-100 |
   | Tool-Specific Guidance | Medium | 100-200 |

2. **Calculate what to extract:** Remove sections until SKILL.md is under 400 lines (leaving room for decision tree).

### How to Split

**Step 1:** Create file structure:
```
skills/{name}/
├── SKILL.md           # Core content + decision tree (target: <400 lines)
├── installation.md    # If extracted
├── advanced.md        # If extracted
├── ci-integration.md  # If extracted
└── troubleshooting.md # If extracted
```

**Step 2:** Transform SKILL.md into a router. Add decision tree after Quick Reference:
```markdown
## Decision Tree

**What do you need?**

├─ First time setup?
│  └─ Read: [Installation Guide](installation.md)
│
├─ Basic usage?
│  └─ See: Quick Reference above
│
├─ Advanced features?
│  └─ Read: [Advanced Usage](advanced.md)
│
├─ CI/CD integration?
│  └─ Read: [CI Integration](ci-integration.md)
│
└─ Something not working?
   └─ Read: [Troubleshooting](troubleshooting.md)
```

**Step 3:** Each extracted file gets minimal frontmatter:
```yaml
---
parent: {name}
title: Installation Guide
---
```

### What to Keep in SKILL.md

Always keep in SKILL.md (never extract):
- YAML frontmatter (name, type, description)
- When to Use section
- Quick Reference section
- Decision Tree (add if splitting)
- Related Skills section (placeholder for Pass 2)

### Splitting Decision Table

| Total Lines | Action |
|-------------|--------|
| ≤400 | No split needed |
| 401-450 | Review for optional trimming, no split required |
| 451-550 | Extract 1-2 largest sections |
| 551-700 | Extract 2-3 sections |
| >700 | Extract all optional sections, review for content reduction |

### Example Split

**Before (520 lines):**
```
SKILL.md
├── Frontmatter (10 lines)
├── When to Use (30 lines)
├── Quick Reference (40 lines)
├── Installation (90 lines)      ← Extract
├── Core Workflow (80 lines)
├── Advanced Usage (120 lines)   ← Extract
├── CI/CD Integration (70 lines) ← Extract
├── Common Mistakes (30 lines)
├── Related Skills (20 lines)
└── Resources (30 lines)
```

**After split:**
```
SKILL.md (280 lines)
├── Frontmatter (10 lines)
├── When to Use (30 lines)
├── Quick Reference (40 lines)
├── Decision Tree (40 lines)     ← Added
├── Core Workflow (80 lines)
├── Common Mistakes (30 lines)
├── Related Skills (20 lines)
└── Resources (30 lines)

installation.md (90 lines)
advanced.md (120 lines)
ci-integration.md (70 lines)
```

## Scope Restriction

ONLY write to: `{output_dir}/{name}/`
Do NOT read/modify other plugins, skills, or testing-handbook-generator itself.

## Output Report

After writing, output this report (used for orchestration and cross-reference tracking):

### Pass 1 Report
```
## {name} (Pass 1)
- **Lines:** {count}
- **Split:** {Yes - files listed | No}
- **Sections:** {populated sections, comma-separated}
- **Gaps:** {missing template sections, or "None"}
- **Warnings:** {issues encountered, or "None"}
- **References:** DEFERRED (Pass 2)
```

### Pass 2 Report
```
## {name} (Pass 2)
- **References:** {skill names in Related Skills section, comma-separated}
- **Broken refs:** {skill names that don't exist, or "None"}
```
