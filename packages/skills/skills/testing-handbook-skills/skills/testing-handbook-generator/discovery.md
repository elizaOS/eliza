# Discovery Workflow

Methodology for analyzing the Testing Handbook and identifying skill candidates.

**Quick Navigation:**
- [Phase 0: Locate Handbook](#phase-0-locate-handbook)
- [Phase 1: Handbook Analysis](#phase-1-handbook-analysis)
- [Phase 2: Plan Generation](#phase-2-plan-generation)
- [Phase 3: Prepare Generation Context](#phase-3-prepare-generation-context)

## Progress Tracking

Use TodoWrite throughout discovery to track progress and give visibility to the user:

```
Discovery phase todos:
- [ ] Locate handbook repository
- [ ] Scan /fuzzing/ sections
- [ ] Scan /static-analysis/ sections
- [ ] Scan /crypto/ sections
- [ ] Scan /web/ sections
- [ ] Build candidate list with types
- [ ] Resolve conflicts and edge cases
- [ ] Present plan to user
- [ ] Await user approval
```

Mark each todo as `in_progress` when starting and `completed` when done. This helps users understand where you are in the process.

## Phase 0: Locate Handbook

Before analysis, locate or obtain the Testing Handbook repository.

### Step 1: Check Common Locations

```bash
# Check common locations (simple version)
for dir in ./testing-handbook ../testing-handbook ~/testing-handbook; do
  [ -d "$dir/content/docs" ] && handbook_path="$dir" && echo "✓ Found: $dir" && break
done
[ -z "$handbook_path" ] && echo "Handbook not found in common locations"
```

### Step 2: Ask User (if not found)

If handbook not found in common locations:
> "Where is the Testing Handbook repository located? (full path)"

### Step 3: Clone as Last Resort (if user agrees)

```bash
git clone --depth=1 https://github.com/trailofbits/testing-handbook.git
handbook_path="./testing-handbook"
```

### Set handbook_path Variable

Once located, set `handbook_path` and use it for all subsequent paths:
```bash
handbook_path="/path/to/testing-handbook"  # Set to actual location
```

All paths below are relative to `{handbook_path}`.

### Error Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Handbook not in common locations | Step 1 finds nothing | Ask user for path (Step 2) |
| User doesn't know path | User says "I don't know" | Offer to clone (Step 3) |
| Clone fails (network/permissions) | git clone returns error | Report error, ask user to clone manually and provide path |
| `content/docs/` missing | Directory doesn't exist after locating | Invalid handbook - ask user to verify it's the correct repo |
| Handbook is outdated | User mentions old content | Suggest `git pull` in handbook directory |

## Phase 1: Handbook Analysis

### 1.1 Scan Directory Structure

Scan the handbook at:
```
{handbook_path}/content/docs/
```

Directory structure pattern:
```
docs/
├── fuzzing/
│   ├── _index.md              # Section overview
│   ├── c-cpp/
│   │   ├── _index.md          # Language subsection
│   │   ├── 10-libfuzzer/      # Tool directory
│   │   │   └── index.md
│   │   ├── 11-aflpp/
│   │   └── techniques/        # Shared techniques
│   └── rust/
├── static-analysis/
│   ├── semgrep/
│   │   ├── _index.md
│   │   ├── 00-installation.md
│   │   ├── 10-advanced.md
│   │   ├── 20-ci.md
│   │   └── 99-resources.md
│   └── codeql/
├── crypto/
│   ├── wycheproof/
│   └── constant_time_tool/
└── web/
    └── burp/
```

### 1.2 Parse Frontmatter

Each markdown file has YAML frontmatter:

```yaml
---
title: "Semgrep"
weight: 2
summary: "Fast static analysis for finding bugs..."
bookCollapseSection: true
draft: false                    # Check this!
---
```

**Key fields:**
| Field | Purpose |
|-------|---------|
| `title` | Skill name candidate |
| `summary` | Skill description source |
| `weight` | Ordering (lower = more important) |
| `bookCollapseSection` | Indicates major section |
| `draft` | If `true`, skip this section |

### 1.3 Identify Skill Candidates

**Decision Table:**

For each directory found, apply the first matching rule:

| Directory Pattern | Has | Skill Type | Action |
|-------------------|-----|------------|--------|
| `_index.md` with `bookCollapseSection: true` | - | Container | Scan children, don't create skill for container itself |
| `**/static-analysis/[name]/` | Numbered files (00-, 10-) | Tool | Create tool skill |
| `**/fuzzing/[lang]/[name]/` | `index.md` or numbered files | Fuzzer | Create fuzzer skill |
| `**/fuzzing/techniques/[name]/` | Any `.md` files | Technique | Create technique skill |
| `**/crypto/[name]/` | Any `.md` files | Domain | Create domain skill |
| `**/web/[name]/` | Numbered files or `_index.md` | Tool | Create tool skill (but check exclusions) |
| Named `techniques/` | Subdirectories | Container | Create one technique skill per subdirectory |
| Any other | Only `_index.md` | Skip | Not enough content |

**Hard Exclusions (GUI-only tools):**

Some handbook sections describe tools that require graphical user interfaces and cannot be operated by Claude. Skip these unconditionally:

| Section | Tool | Reason |
|---------|------|--------|
| `**/web/burp/` | Burp Suite | GUI-based HTTP proxy; requires visual interaction |

These tools are excluded because Claude cannot:
- Launch or interact with GUI applications
- Click buttons, navigate menus, or view visual elements
- Operate browser-based or desktop UI tools

For web security testing, prefer CLI-based alternatives documented elsewhere (e.g., `curl`, `httpie`, custom scripts).

**Classification priority** (when multiple patterns match):
1. Most specific path wins (deeper = higher priority)
2. Type preference: Tool > Fuzzer > Technique > Domain
3. When in doubt, flag for user review in the plan

**Examples:**

| Path | Matches | Result |
|------|---------|--------|
| `/fuzzing/c-cpp/10-libfuzzer/` | Fuzzer pattern | `libfuzzer` (fuzzer) |
| `/static-analysis/semgrep/` | Tool pattern | `semgrep` (tool) |
| `/fuzzing/techniques/writing-harnesses/` | Technique pattern | `harness-writing` (technique) |
| `/crypto/wycheproof/` | Domain pattern | `wycheproof` (domain) |

### 1.4 Build Candidate List

For each candidate, extract:

```yaml
- name: libfuzzer
  type: fuzzer
  source: /docs/fuzzing/c-cpp/10-libfuzzer/
  summary: "libFuzzer is a coverage-guided fuzzer..."
  weight: 1
  has_resources: true           # Has 99-resources.md
  related_sections:
    - /docs/fuzzing/techniques/01-writing-harnesses/
    - /docs/fuzzing/techniques/03-asan/
```

### 1.5 Candidate Prioritization

When many candidates exist, prioritize by:

| Priority | Criterion | Rationale |
|----------|-----------|-----------|
| 1 | Weight field (lower = higher) | Handbook author's intent |
| 2 | Content depth (more numbered files) | More complete documentation |
| 3 | Has resources file | External links add value |
| 4 | Core section (fuzzing, static-analysis) | Fundamental topics |
| 5 | Recently updated | More relevant content |

**Conflict resolution:**
- If multiple patterns match a section, use the **most specific** (deepest path wins)
- If a section could be multiple types, prefer: Tool > Fuzzer > Technique > Domain
- When in doubt, flag for user review in the plan

## Phase 2: Plan Generation

### 2.1 Plan Format

Present to user in this format:

```markdown
# Skill Generation Plan

## Summary
- **Handbook analyzed:** {handbook_path}
- **Total sections:** 25
- **Skills to generate:** 8
- **Sections to skip:** 2

---

## Skills to Generate

| # | Skill Name | Source Section | Type | Related Sections |
|---|------------|----------------|------|------------------|
| 1 | libfuzzer | /fuzzing/c-cpp/10-libfuzzer/ | Fuzzer | techniques/asan, techniques/harness |
| 2 | aflpp | /fuzzing/c-cpp/11-aflpp/ | Fuzzer | techniques/asan |
| 3 | cargo-fuzz | /fuzzing/rust/10-cargo-fuzz/ | Fuzzer | - |
| 4 | wycheproof | /crypto/wycheproof/ | Domain | - |
| 5 | fuzz-harness-writing | /fuzzing/techniques/01-writing-harnesses/ | Technique | - |
| 6 | coverage-analysis | /fuzzing/c-cpp/techniques/01-coverage/ | Technique | - |
| 7 | address-sanitizer | /fuzzing/techniques/03-asan/ | Technique | - |

---

## Skipped Sections

| Section | Reason |
|---------|--------|
| /docs/dynamic-analysis/ | `draft: true` in frontmatter |
| /docs/fuzzing/3-python.md | Single file, insufficient content |
| /docs/web/burp/ | GUI-only tool (excluded) |

---

## External Resources to Fetch

| Section | Resource Count | Source File |
|---------|---------------|-------------|
| Fuzzing | 5 | /fuzzing/91-resources.md |
| Semgrep | 3 | /static-analysis/semgrep/99-resources.md |
| CodeQL | 4 | /static-analysis/codeql/99-resources.md |

---

## Actions

- [ ] Confirm plan and proceed with generation
- [ ] Modify: Remove skill #X from plan
- [ ] Modify: Change skill #Y type
- [ ] Cancel generation
```

Make the actions navigable and selectable if possible using built-in tool like TodoWrite. 

### 2.2 User Interaction

After presenting plan:

1. Wait for user confirmation or modifications
2. Apply any modifications to plan
3. Proceed with generation only after explicit approval

**Acceptable modifications:**
- Remove skills from plan
- Change skill type
- Skip updates
- Add custom related sections
- Change skill names

## Phase 3: Prepare Generation Context

This phase prepares everything needed for generation agents. It combines content aggregation with agent handoff preparation.

### 3.1 Collect Content Per Skill

For each approved skill, collect content from:

1. **Primary section:** Main `_index.md` or `index.md`
2. **Numbered files:** `00-installation.md`, `10-advanced.md`, etc.
3. **Related sections:** As specified in `related_sections`
4. **Resources:** From `99-resources.md` (titles only)

### 3.2 Content Processing Rules

Content processing rules are defined in the agent prompt template.

**Authoritative source:** [agent-prompt.md](agent-prompt.md#critical-rules)

The agent prompt contains:
- Hugo shortcode conversion table
- Code block preservation rules
- Image/video handling
- YAML frontmatter requirements
- Pre-write validation checklist
- **Line count splitting rules** (when to split large skills)

Do not duplicate these rules here. Generation agents receive them via the prompt template.

### 3.3 External Resources

Extract from `99-resources.md` or `91-resources.md`:

```markdown
## Resources

- [Introduction to Semgrep](https://www.youtube.com/watch?v=...) - Trail of Bits Webinar
- [Semgrep Documentation](https://semgrep.dev/docs/) - Official docs
- [Custom Rules Guide](https://semgrep.dev/docs/writing-rules/) - Rule authoring
```

**For non-video resources (documentation, blogs, guides):**
- Use WebFetch to retrieve content
- Extract key insights, techniques, code examples
- Summarize actionable information for the skill
- Include attribution with URL

**For video resources (YouTube, Vimeo, etc.):**
- Extract title and URL only
- Do NOT attempt to fetch video content
- Include brief description if available in handbook

**Video URL patterns to skip fetching:**
- `youtube.com`, `youtu.be`
- `vimeo.com`
- `*.mp4`, `*.webm`, `*.mov` direct links
- `twitch.tv`, `dailymotion.com`

### 3.4 Edge Case Handling

| Situation | Detection | Action |
|-----------|-----------|--------|
| Empty handbook section | Directory exists but no `.md` files | Skip, add to "Skipped Sections" with reason |
| Draft content | `draft: true` in frontmatter | Skip entirely, do not include in plan |
| Missing `_index.md` | Directory has content but no index | Use first numbered file for metadata |
| Conflicting frontmatter | Different titles in `_index.md` vs content | Use `_index.md` values, note discrepancy |
| Missing resources file | No `99-resources.md` or `91-resources.md` | Omit Resources section from generated skill |
| Circular references | Section A references B, B references A | Include each once, note relationship |
| Very large section | >20 markdown files | Flag for splitting (see agent-prompt.md) |
| Incomplete section | `TODO` or placeholder text | Flag in plan for user decision |

### 3.5 Build Per-Skill Package

Each skill generation agent receives variables that map directly to the agent prompt template:

```yaml
# Agent prompt variables (see agent-prompt.md for full template)
name: "libfuzzer"                              # {name} - skill name (lowercase)
type: "fuzzer"                                 # {type} - tool|fuzzer|technique|domain
pass: 1                                        # {pass} - 1=content only, 2=cross-refs only
handbook_path: "/path/to/testing-handbook"     # {handbook_path} - absolute path
section_path: "fuzzing/c-cpp/10-libfuzzer"     # {section_path} - relative to content/docs/
output_dir: "/path/to/skills/plugins/testing-handbook-skills/skills"  # {output_dir}
template_path: "skills/testing-handbook-generator/templates/fuzzer-skill.md"  # {template_path}
related_sections: "fuzzing/techniques/01-writing-harnesses, fuzzing/techniques/03-asan"
# ^ Use comma-separated list OR empty string "" if no related sections

# Metadata (for orchestrator tracking, not passed to agent)
metadata:
  title: "libFuzzer"                           # From frontmatter
  summary: "Coverage-guided fuzzer..."         # From frontmatter
  has_resources: true                          # Has 99-resources.md
  estimated_lines: 350                         # Approximate output size
```

**Variable mapping to agent prompt:**

| Package Field | Agent Prompt Variable | Example |
|---------------|----------------------|---------|
| `name` | `{name}` | `libfuzzer` |
| `type` | `{type}` | `fuzzer` |
| `pass` | `{pass}` | `1` or `2` |
| `handbook_path` | `{handbook_path}` | `/path/to/testing-handbook` |
| `section_path` | `{section_path}` | `fuzzing/c-cpp/10-libfuzzer` |
| `output_dir` | `{output_dir}` | `/path/to/skills/plugins/testing-handbook-skills/skills` |
| `template_path` | `{template_path}` | `skills/testing-handbook-generator/templates/fuzzer-skill.md` |
| `related_sections` | `{related_sections}` | Comma-separated list or empty string |

**Building the package:**

```bash
# Construct output_dir from current location
output_dir="$(cd .. && pwd)"  # Parent of testing-handbook-generator

# Construct template_path from type
template_path="skills/testing-handbook-generator/templates/${type}-skill.md"

# Format related sections (empty string if none)
if [ ${#related_sections[@]} -eq 0 ]; then
  related_sections=""
else
  related_sections=$(IFS=', '; echo "${related_sections[*]}")
fi
```

### 3.6 Pre-Generation Validation

Before launching generation agents, verify:

```
For each skill candidate:
├─ Primary content exists and is non-empty
├─ Frontmatter has title and summary
├─ At least one code block present (for tool/fuzzer types)
├─ No unresolved Hugo shortcodes in source content
├─ Related sections (if any) are accessible
└─ Template file exists for skill type
```

**If validation fails:**
- Log the specific failure
- Move candidate to "Skipped Sections" with reason
- Continue with remaining candidates

### 3.7 Launch Generation

**Trigger conditions:**
- User has approved plan (explicit confirmation)
- All source paths verified accessible
- All per-skill packages prepared

**Launch sequence:**
1. Launch Pass 1 agents in parallel (content generation)
2. Wait for all Pass 1 agents to complete
3. Run Pass 2 (cross-reference population) - see [SKILL.md](SKILL.md#two-pass-generation-phase-3)
4. Run validator on all generated skills

### 3.8 Success Criteria

Phase 3 complete when:
- [ ] All skill packages prepared with variables
- [ ] Pass 1 agents launched and completed
- [ ] Pass 2 cross-references populated
- [ ] All generated skills pass validation
