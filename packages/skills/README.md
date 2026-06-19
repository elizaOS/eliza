# @elizaos/skills

Bundled skills and skill loading utilities for elizaOS agents.

## Overview

Skills are markdown files that provide specialized instructions for AI agents to perform specific tasks. Each skill contains:

- **Frontmatter**: YAML metadata including name, description, and configuration
- **Body**: Detailed instructions, examples, and references

## Installation

```bash
npm install @elizaos/skills
# or
bun add @elizaos/skills
```

## Usage

### Get Bundled Skills Path

```typescript
import { getSkillsDir } from "@elizaos/skills";

const skillsPath = getSkillsDir();
// Returns absolute path to bundled skills directory
```

### Load Skills

```typescript
import { loadSkills, loadSkillsFromDir } from "@elizaos/skills";

// Load from all default locations (bundled + managed + project)
const { skills, diagnostics } = loadSkills();

// Load from a specific directory
const result = loadSkillsFromDir({
  dir: "/path/to/skills",
  source: "custom",
});
```

### Format for LLM Prompt

```typescript
import { formatSkillsForPrompt } from "@elizaos/skills";

const prompt = formatSkillsForPrompt(skills);
// Returns a compact structured skills section for system prompt
```

### Build Command Specs

```typescript
import { loadSkillEntries, buildSkillCommandSpecs } from "@elizaos/skills";

const entries = loadSkillEntries();
const commands = buildSkillCommandSpecs(entries);
// Returns array of command specs for chat interfaces
```

## Bundled documentation skills

Alongside community-oriented skills, this package ships **`elizaos`**, **`eliza-cloud`**, and **`eliza-app-development`** — concise references for elizaOS runtime concepts, Eliza Cloud as a backend, and building elizaOS-based applications (including the Eliza app repository layout).

## Skill Discovery

Skills are loaded from multiple locations in precedence order (later overrides earlier):

1. **Bundled skills** - Included in this package (`skills/`)
2. **Managed skills** - User-installed skills (`<stateDir>/skills/`)
3. **Curated/active** - Human- or agent-promoted skills (`<stateDir>/skills/curated/active/`)
4. **Project skills** - Project-local skills (`<cwd>/.elizaos/skills/`)
5. **Explicit paths** - Via `skillPaths` option

## Skill Format

Skills are markdown files with YAML frontmatter:

```markdown
---
name: my-skill
description: A brief description of what this skill does
primary-env: node
required-bins:
  - node
  - npm
---

# My Skill

Detailed instructions for the AI agent...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Skill name (must match directory name) |
| `description` | string | Human-readable description (required) |
| `disable-model-invocation` | boolean | If true, skill won't appear in prompts |
| `user-invocable` | boolean | If false, can't be invoked via commands |
| `primary-env` | string | Primary runtime (node, python, etc.) |
| `required-os` | string[] | Required operating systems |
| `required-bins` | string[] | Required binaries in PATH |
| `required-env` | string[] | Required environment variables |
| `command-dispatch` | string | Set to `tool` to enable tool-dispatch in `buildSkillCommandSpecs` |
| `command-tool` | string | Tool name used when `command-dispatch: tool` |

## API Reference

### Types

- `Skill` - Loaded skill with metadata
- `SkillFrontmatter` - Parsed frontmatter
- `SkillEntry` - Full skill entry with all metadata
- `SkillMetadata` - Resolved metadata (env, bins, os)
- `SkillInvocationPolicy` - Resolved invocation flags
- `SkillCommandSpec` - Command spec for chat interfaces
- `SkillProvenance` - Provenance tracking for the learning loop
- `LoadSkillsResult` - Result from loading skills

### Discovery / Resolution

- `getSkillsDir()` - Get bundled skills path
- `clearSkillsDirCache()` - Reset bundled-dir resolution cache
- `getCuratedActiveDir()` - `<stateDir>/skills/curated/active/`
- `getProposedSkillsDir()` - `<stateDir>/skills/curated/proposed/`
- `promoteSkill(name)` - Move a proposed skill to active atomically

### Loading

- `loadSkills(options?)` - Load from all locations
- `loadSkillsFromDir(options)` - Load from single directory
- `loadSkillEntries(options?)` - Load with full metadata parsed into `SkillEntry[]`

### Formatting

- `formatSkillsForPrompt(skills)` - Format `Skill[]` for system prompt
- `formatSkillEntriesForPrompt(entries)` - Same but from `SkillEntry[]` (respects invocation policy)
- `formatSkillSummary(skill)` - Single `"name: description"` string
- `formatSkillsList(skills)` - Newline-joined list
- `buildSkillCommandSpecs(entries, reservedNames?)` - Build command specs

### Frontmatter

- `parseFrontmatter(content)` - Parse YAML frontmatter from markdown string
- `stripFrontmatter(content)` - Return body without frontmatter
- `serializeSkillFile(frontmatter, body)` - Re-serialize frontmatter + body (learning loop)
- `resolveSkillMetadata(frontmatter)` - Resolve `SkillMetadata` from frontmatter
- `resolveSkillInvocationPolicy(frontmatter)` - Resolve `SkillInvocationPolicy`
- `resolveSkillProvenance(frontmatter)` - Resolve `SkillProvenance` (returns `undefined` if missing/malformed)
