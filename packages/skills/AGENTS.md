# @elizaos/skills

Bundled skills library and skill loading utilities for elizaOS agents.

## Purpose

This package ships 34 bundled skills (markdown instruction files) and the TypeScript API for discovering, loading, and formatting them. The agent runtime (`packages/agent`) calls `getSkillsDir()` at startup to pass the bundled skills directory to `@elizaos/plugin-agent-skills`, which injects relevant skills into the agent's system prompt each turn. `@elizaos/plugin-agent-skills` also imports the loader and formatter directly.

This package is **not** a plugin — it exports pure utility functions and the bundled skill files. It does not register actions, providers, or services.

## Layout

```
packages/skills/
  src/
    index.ts          — re-exports all public API
    types.ts          — all shared TypeScript types (Skill, SkillEntry, SkillFrontmatter, etc.)
    loader.ts         — loadSkills(), loadSkillsFromDir(), loadSkillEntries()
    resolver.ts       — getSkillsDir(), getCuratedActiveDir(), getProposedSkillsDir(), promoteSkill()
    frontmatter.ts    — parseFrontmatter(), resolveSkillMetadata(), resolveSkillProvenance(), serializeSkillFile()
    formatter.ts      — formatSkillsForPrompt(), formatSkillEntriesForPrompt(), buildSkillCommandSpecs()
  skills/             — 34 bundled skill directories, each with a SKILL.md
  test/               — unit tests for each src module
```

## Key Exports

```typescript
import {
  // Discovery
  getSkillsDir,           // absolute path to the bundled skills/ directory
  getCuratedActiveDir,    // <stateDir>/skills/curated/active (loaded at runtime)
  getProposedSkillsDir,   // <stateDir>/skills/curated/proposed (staged for review, NOT loaded)
  promoteSkill,           // move a proposed skill to active atomically
  clearSkillsDirCache,    // reset the bundled-dir resolution cache

  // Loading
  loadSkills,             // load from all default locations; returns { skills, diagnostics }
  loadSkillsFromDir,      // load from a single directory
  loadSkillEntries,       // loadSkills + full frontmatter/metadata parsed into SkillEntry[]

  // Formatting
  formatSkillsForPrompt,        // format Skill[] into system-prompt text block
  formatSkillEntriesForPrompt,  // same but from SkillEntry[] (respects invocation policy)
  buildSkillCommandSpecs,       // build SkillCommandSpec[] for chat UI command dispatch
  formatSkillSummary,           // single "name: description" string
  formatSkillsList,             // newline-joined list

  // Frontmatter
  parseFrontmatter,             // parse YAML frontmatter from markdown string
  stripFrontmatter,             // return body without frontmatter
  serializeSkillFile,           // re-serialize frontmatter + body (used by learning loop)
  resolveSkillMetadata,
  resolveSkillInvocationPolicy,
  resolveSkillProvenance,
} from "@elizaos/skills";
```

## Skill Discovery Precedence

`loadSkills()` merges from these sources in order (later overrides earlier on name collision):

1. **bundled** — `getSkillsDir()` (this package's `skills/`)
2. **managed** — `<stateDir>/skills/`
3. **curated/active** — `<stateDir>/skills/curated/active/` (human-promoted or agent-promoted)
4. **project** — `<cwd>/.elizaos/skills/`
5. **explicit paths** — `skillPaths` option

`curated/proposed/` is staged and never loaded automatically.

## Skill File Format

Every skill lives in its own directory with a `SKILL.md`:

```markdown
---
name: my-skill          # must match directory name; lowercase a-z 0-9 hyphens only
description: "..."      # required; max 1024 chars
disable-model-invocation: false   # if true, excluded from system prompt
user-invocable: true              # if false, cannot be triggered via /commands
primary-env: node                 # optional runtime hint
required-bins: [node, npm]        # optional; surfaced in SkillMetadata
required-env: [MY_VAR]            # optional
command-dispatch: tool            # optional; enables tool-dispatch in buildSkillCommandSpecs
command-tool: USE_SKILL           # tool name when command-dispatch: tool
---

Body markdown — detailed instructions for the agent.
```

The root `skills/` directory can also hold flat `.md` files (loaded as root-level skills); subdirectories must use `SKILL.md`.

## Commands

```bash
bun run --cwd packages/skills build       # tsc compile to dist/
bun run --cwd packages/skills dev         # tsc watch
bun run --cwd packages/skills test        # run test/
bun run --cwd packages/skills lint        # biome check --write src/
bun run --cwd packages/skills lint:check  # biome check src/ (no write)
bun run --cwd packages/skills clean       # rm -rf dist
```

## Config / Env Vars

| Variable | Effect |
|---|---|
| `ELIZAOS_BUNDLED_SKILLS_DIR` | Override the bundled skills directory resolution |

`resolveStateDir()` from `@elizaos/core` controls the managed/curated skill locations; it honors `ELIZA_STATE_DIR`.

## Adding a Bundled Skill

1. Create `skills/<your-skill-name>/SKILL.md` with valid frontmatter (`name` matching the dir, `description` required).
2. Add any reference docs as sibling files (e.g. `skills/<name>/references/`).
3. The skill is picked up by `loadSkills()` automatically — no code changes needed.
4. If the skill should be excluded from system-prompt injection but still loadable, set `disable-model-invocation: true`.
5. If users should not be able to invoke it via slash-commands, set `user-invocable: false`.

## Conventions and Gotchas

- **Name must equal directory name.** The loader validates this and warns on mismatch. Names are lowercase `[a-z0-9-]+`, max 64 chars, no leading/trailing/consecutive hyphens.
- **Description is required.** A skill with a missing or blank description is silently dropped by the loader.
- **Curated learning loop.** Agent-generated skills land in `curated/proposed/` and require human promotion via `promoteSkill(name)` (or the Settings UI) before they load. This prevents untrusted agent output from injecting itself into the prompt.
- **Symlinks are resolved.** The loader follows symlinks using `statSync`; duplicate real paths are deduplicated.
- **`serializeSkillFile` is for the learning loop.** Call it to rewrite a SKILL.md after refining provenance/content. It serializes frontmatter as YAML and preserves the body.
- **`buildSkillCommandSpecs` sanitizes names.** Command names are lowercased, non-alphanumeric chars replaced with underscores, and truncated to 32 chars. Collisions get a numeric suffix.
- **No circular deps.** This package depends only on `@elizaos/core` (for `resolveStateDir`) and `yaml`. Do not add dependencies on agent or plugin packages.
