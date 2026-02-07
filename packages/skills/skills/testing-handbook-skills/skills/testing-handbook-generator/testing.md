# Testing Strategy

Methodology for validating generated skills.

## Prerequisites

Required tools for validation:

### Python Dependencies

Install from the scripts directory:

```bash
cd plugins/testing-handbook-skills/scripts
uv pip install .
```

### Optional Tools

- `yq` - YAML processor for manual checks: `brew install yq` (macOS)

## Automated Validation

Use the validator script for comprehensive validation:

```bash
# Validate all generated skills
uv run scripts/validate-skills.py

# Validate specific skill
uv run scripts/validate-skills.py --skill libfuzzer

# Output JSON for CI integration
uv run scripts/validate-skills.py --json

# Verbose output with details
uv run scripts/validate-skills.py -v
```

The validator checks:
- YAML frontmatter parsing and field validation (name, description)
- Required sections presence by skill type
- Line count limits (<500)
- Hugo shortcode detection
- Cross-reference validation (related skills exist)
- Internal link resolution

## Path Convention

All paths in this document are relative to `testing-handbook-generator/`:
- Generated skills: `../[skill-name]/SKILL.md`
- Templates: `./templates/[type]-skill.md`

## Quick Validation Reference

**Recommended:** Use the automated validator:

```bash
uv run scripts/validate-skills.py --skill [skill-name]
```

**Manual checks** (for debugging or when validator is unavailable):

| Check | Command | Pass | Fail |
|-------|---------|------|------|
| Line count | `wc -l SKILL.md` | < 500 | ≥ 500 |
| Hugo shortcodes | `grep -cE '\{\{[<%]' SKILL.md` | 0 | > 0 |
| Escaped backticks | `grep -cE '\\`{3}' SKILL.md` | 0 | > 0 |
| YAML valid | `head -50 SKILL.md \| yq -e '.' 2>&1` | No output | Error message |
| Name format | `yq '.name' SKILL.md` | `lowercase-name` | Mixed case, spaces, or special chars |
| Description exists | `yq '.description' SKILL.md` | Non-empty string | `null` or empty |
| Required sections | `grep -c '^## ' SKILL.md` | ≥ 3 | < 3 |

## One-Liner Validation

**Recommended:** Use the automated validator for all checks:

```bash
# Validate all skills at once
uv run scripts/validate-skills.py

# JSON output for CI pipelines
uv run scripts/validate-skills.py --json
```

**Legacy shell commands** (for environments without Python):

```bash
SKILL="../libfuzzer/SKILL.md" && \
  [ $(wc -l < "$SKILL") -lt 500 ] && \
  [ $(grep -cE '\{\{[<%]' "$SKILL") -eq 0 ] && \
  awk '/^---$/{if(++n==2)exit}n==1' "$SKILL" | yq -e '.' >/dev/null 2>&1 && \
  echo "✓ Valid: $SKILL" || echo "✗ Invalid: $SKILL"
```

## Validity Checks

Run these checks on every generated skill before delivery.

### 1. YAML Frontmatter Validation

**Check:** Frontmatter parses without errors

```bash
# Set skill path (replace 'libfuzzer' with target skill name)
SKILL="../libfuzzer/SKILL.md"

# Extract and validate frontmatter (awk extracts content between first two ---)
awk '/^---$/{if(++n==2)exit}n==1' "$SKILL" | yq -e '.'

# Validate name field
NAME=$(yq '.name' "$SKILL")
echo "$NAME" | grep -qE '^[a-z0-9-]{1,64}$' && echo "Name: OK" || echo "Name: INVALID"

# Validate description length
DESC=$(yq '.description' "$SKILL")
[ ${#DESC} -le 1024 ] && [ ${#DESC} -gt 0 ] && echo "Description: OK" || echo "Description: INVALID"
```

**Required fields:**
| Field | Requirement | Validation |
|-------|-------------|------------|
| `name` | Present, lowercase, max 64 chars | Pattern: `^[a-z0-9-]{1,64}$` |
| `type` | Recommended, one of: tool, fuzzer, technique, domain | Determines required sections |
| `description` | Present, non-empty, max 1024 chars | Length: 1-1024 chars |

**Validation rules:**
- No XML/HTML tags in name or description (pattern: `<[^>]+>`)
- No reserved words ("anthropic", "claude") in name
- `type` field ensures correct section validation (if missing, type is inferred from content)
- Description should include both "what" (tool purpose) and "when" (trigger conditions)
- No Hugo shortcodes in frontmatter (pattern: `\{\{[<%]`)

**Trigger phrase validation:**

The description MUST include a trigger phrase ("Use when" or "Use for"):

```bash
# Check for trigger phrase in description
DESC=$(yq '.description' "$SKILL")
echo "$DESC" | grep -qE 'Use when|Use for' && echo "Trigger: OK" || echo "Trigger: MISSING"
```

### 2. Required Sections

**Check:** Skill contains essential sections

| Section | Required | Purpose |
|---------|----------|---------|
| `# Title` | Yes | Main heading |
| `## When to Use` | Yes | Trigger conditions |
| `## Quick Reference` or `## Quick Start` | Yes | Fast access to key info |
| Core workflow/content sections | Yes | Main skill content |
| `## Resources` | If handbook has resources | External links |

**Template-specific required sections:**

| Skill Type | Required Sections |
|------------|-------------------|
| Tool | When to Use, Quick Reference, Installation, Core Workflow |
| Fuzzer | When to Use, Quick Start, Writing a Harness, Related Skills |
| Technique | When to Apply, Quick Reference, Tool-Specific Guidance, Related Skills |
| Domain | Background, Quick Reference, Testing Workflow, Related Skills |

**Section validation command:**

```bash
# Validate required sections for a tool skill
SKILL="../semgrep/SKILL.md"
REQUIRED=("When to Use" "Quick Reference" "Installation" "Core Workflow")

for section in "${REQUIRED[@]}"; do
  grep -q "^## $section" "$SKILL" && echo "✓ $section" || echo "✗ Missing: $section"
done
```

**Related Skills validation:**

For Fuzzer, Technique, and Domain skills, verify that the Related Skills section exists and references valid skills:

```bash
# Check Related Skills section exists
grep -q "^## Related Skills" "$SKILL" || echo "✗ Missing: Related Skills section"

# Extract skill references and check they exist
grep -oE '\*\*[a-z0-9-]+\*\*' "$SKILL" | tr -d '*' | sort -u | while read ref; do
  [ -d "../$ref" ] && echo "✓ $ref exists" || echo "⚠ $ref not found (may be planned)"
done
```

### 3. Line Count

**Check:** SKILL.md under 500 lines

```bash
wc -l ../libfuzzer/SKILL.md  # Replace 'libfuzzer' with target skill
# Should be < 500
```

**If over 500 lines:**
- Split into supporting files
- Keep SKILL.md as overview with decision tree
- Reference supporting files with relative links

### 4. Internal Reference Resolution

**Check:** All internal links resolve

```bash
SKILL="../libfuzzer/SKILL.md"  # Replace 'libfuzzer' with target skill
SKILL_DIR=$(dirname "$SKILL")

# Find markdown links and verify they exist
grep -oE '\[.+\]\(([^)]+)\)' "$SKILL" | grep -oE '\([^)]+\)' | tr -d '()' | while read link; do
  # Skip external URLs
  [[ "$link" =~ ^https?:// ]] && continue
  # Check if file exists
  [ -f "$SKILL_DIR/$link" ] && echo "✓ $link" || echo "✗ $link (not found)"
done
```

**Common issues:**
| Issue | Fix |
|-------|-----|
| Link to non-existent file | Create file or remove link |
| Broken anchor | Update anchor or content |
| Absolute path used | Convert to relative path |

### 5. Code Block Preservation

**Check:** Code blocks preserved from handbook

Compare code blocks in generated skill vs source handbook section:
- Indentation preserved
- Language specifier present
- No truncation

### 6. Hugo Shortcode Removal

**Check:** No Hugo shortcodes remain

```bash
# Should return nothing (exit code 1 = pass, exit code 0 = shortcodes found)
grep -E '\{\{[<%]' ../libfuzzer/SKILL.md  # Replace 'libfuzzer' with target skill
```

**Shortcodes to remove:**
- `{{< hint >}}...{{< /hint >}}`
- `{{< tabs >}}...{{< /tabs >}}`
- `{{< customFigure >}}`
- `{{% relref "..." %}}`

## Activation Testing

Verify Claude activates the skill correctly.

### Test 1: Direct Invocation

**Prompt:** "Use the [skill-name] skill"

**Expected:**
- Claude loads SKILL.md
- Claude references skill content
- Claude follows skill workflow

### Test 2: Implicit Trigger

**Sample prompts by skill type:**

| Skill Type | Test Prompt |
|------------|-------------|
| Tool (semgrep) | "Scan this Python code for security issues" |
| Tool (codeql) | "Set up CodeQL for my Java project" |
| Fuzzer (libfuzzer) | "Help me fuzz this C function" |
| Fuzzer (aflpp) | "Set up AFL++ for multi-core fuzzing" |
| Technique (harness) | "Write a fuzzing harness for this parser" |
| Technique (coverage) | "Analyze coverage of my fuzzing campaign" |
| Domain (wycheproof) | "Test my ECDSA implementation" |
| Domain (constant-time) | "Check if this crypto code has timing leaks" |

**Expected:**
- Skill description matches prompt intent
- Claude selects this skill over alternatives
- Claude uses skill content appropriately

### Test 3: Decision Tree Navigation

**Test:** Claude navigates to supporting files correctly

**Prompts:**
1. General query → Should use SKILL.md overview
2. Specific topic → Should read appropriate supporting file
3. Advanced topic → Should follow decision tree to detailed doc

## Iteration Loop

```
┌─────────────────────────────────────────────────────┐
│                    Generate Skill                    │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│         Run Validator Script                         │
│  uv run scripts/validate-skills.py --skill [name]   │
│                                                     │
│  Checks: YAML, sections, line count, shortcodes,   │
│          cross-refs, internal links                 │
└─────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         All Pass              Failed
              │                     │
              ▼                     ▼
┌─────────────────────┐   ┌─────────────────────┐
│  Activation Test    │   │   Fix Issues        │
│  - Direct invoke    │   │   - Edit skill      │
│  - Implicit trigger │   │   - Re-run validator│
│  - Decision tree    │   └─────────────────────┘
└─────────────────────┘            │
              │                    │
              ▼                    │
┌─────────────────────┐            │
│     Pass?           │            │
└─────────────────────┘            │
         │                         │
    ┌────┴────┐                    │
   Yes        No                   │
    │         │                    │
    │         └────────────────────┘
    ▼
┌─────────────────────────────────────────────────────┐
│                  Mark Complete                       │
│  - Report success to user                           │
│  - List any warnings from validator                 │
└─────────────────────────────────────────────────────┘
```

## Quality Checklist

Before delivering each generated skill:

```markdown
## Skill: [name]

### Automated Validation
- [ ] Validator passes: `uv run scripts/validate-skills.py --skill [name]`
- [ ] No errors in output
- [ ] Warnings reviewed and addressed (or documented as acceptable)

### Content Quality (manual review)
- [ ] Description includes what AND when
- [ ] When to Use section has clear triggers
- [ ] Quick Reference is actionable
- [ ] Code examples are complete and runnable
- [ ] Resources section has titles and URLs

### Activation Testing
- [ ] Direct invocation works
- [ ] Implicit trigger matches expected prompts
- [ ] Decision tree navigation correct
```

## Bulk Generation Report

When generating multiple skills, use the validator JSON output:

```bash
# Generate JSON report
uv run scripts/validate-skills.py --json > validation-report.json

# Or view in terminal
uv run scripts/validate-skills.py
```

Example validator output:
```
==================================================
VALIDATION REPORT
==================================================
✓ libfuzzer
✓ semgrep ⚠
  WARNING: Line count 480 approaching limit of 500
✗ wycheproof
  ERROR: Missing required sections for domain skill: ['Background']

--------------------------------------------------
Total:    3
Passed:   2
Failed:   1
Warnings: 1
--------------------------------------------------
✗ 1 skill(s) failed validation
```

After validation, document results:

```markdown
# Skill Generation Report

## Validator Results
- Total: X
- Passed: Y
- Failed: Z
- With warnings: W

## Actions Needed

### Failed Skills
1. **wycheproof**: Add Background section

### Warnings
1. **semgrep**: Line count 480 - consider splitting

## Next Steps
- [ ] Fix failed skills
- [ ] Address warnings
- [ ] Run activation tests
```

## Common Issues and Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| YAML parse error | Bad indentation in description | Use `>` for multi-line |
| Missing section | Template not fully populated | Fill from handbook |
| Over 500 lines | Too much detail in main file | Split to supporting files |
| Broken reference | Supporting file not created | Create file or remove link |
| Shortcode remains | Incomplete conversion | Apply shortcode stripping |
| Activation fails | Poor description | Improve trigger keywords |

## Post-Generation Checklist

After all skills pass validation, complete the tasks in [SKILL.md Post-Generation Tasks](SKILL.md#post-generation-tasks).

**Summary of required actions:**
1. Update main `README.md` with generated skills table
2. Capture self-improvement notes

## Self-Improvement Framework

After each generation run, systematically review and improve the generator.

### Review Questions

| Category | Question | If Yes, Update |
|----------|----------|----------------|
| Content extraction | Did any handbook content not extract cleanly? | `discovery.md` (section 3.2) |
| Shortcodes | Were there shortcodes or formats not handled? | `discovery.md` (section 3.2) |
| Manual fixes | Did any skills require manual fixes after generation? | Templates or agent prompt |
| Detection | Are there patterns in the handbook not detected? | `discovery.md` (section 1.3) |
| Activation | Did activation testing reveal description issues? | Templates (description guidance) |
| Validation | Did a bug slip through validation? | `testing.md` (add new check) |

### Improvement Log Format

When making improvements, document them:

```markdown
## Self-Improvement Log

### YYYY-MM-DD: {Brief title}

**Issue:** {What went wrong during generation}
**Example:** {Specific skill/section affected}
**Root cause:** {Why the current logic failed}
**Fix:** {What was changed}
**Files modified:**
- `{file1}`: {what changed}
- `{file2}`: {what changed}
**Verification:** {How to confirm the fix works}
```

### Improvement Priority

| Priority | Criteria | Action |
|----------|----------|--------|
| P0 - Critical | Generated skill is broken/unusable | Fix immediately, re-generate affected skills |
| P1 - High | Content missing or incorrect | Fix before next generation run |
| P2 - Medium | Suboptimal but functional | Add to backlog, fix when convenient |
| P3 - Low | Minor formatting/style issues | Optional improvement |
