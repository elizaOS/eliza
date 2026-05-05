---
title: "Skills"
sidebarTitle: "Skills"
description: "Markdown-based extensions that teach the agent how to perform specific tasks."
---

Skills are markdown-based extensions that teach the Eliza agent how to perform specific tasks. Each skill is a folder containing a `SKILL.md` file with YAML frontmatter and instructional content that gets injected into the agent's context at runtime.

---

## What Are Skills?

A skill is a self-contained unit of knowledge packaged as a directory. At minimum it contains a `SKILL.md` file. The agent reads the skill's instructions and follows them when performing relevant tasks.

Skills can include:

- **Instructions** -- the markdown body of `SKILL.md`, telling the agent what to do
- **Scripts** -- optional shell or Node scripts for setup or automation
- **References** -- additional markdown files loaded into context
- **Assets** -- templates, config files, or other supporting material

### Skills vs Plugins

| Aspect | Skills | Plugins |
|--------|--------|---------|
| Format | Markdown (`SKILL.md`) | TypeScript code |
| Complexity | Low -- documentation-focused | High -- full programmatic control |
| Runtime | Injected into agent prompts | Runs as executable code |
| Use case | Task instructions, workflows | Actions, services, API integrations |
| Installation | Drop a folder or install from marketplace | `eliza plugins install` |

Use skills when you want to teach the agent a procedure. Use plugins when you need executable logic, background services, or API routes.

---

## SKILL.md Format

Every skill directory must contain a `SKILL.md` file. This file has two parts: YAML frontmatter and markdown instructions.

### Example

```markdown
---
name: github
description: "Interact with GitHub using the `gh` CLI"
required-bins:
  - gh
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories.

## Pull Requests

```bash
gh pr list --repo owner/repo
gh pr checks 55 --repo owner/repo
```

## Issues

```bash
gh issue list --repo owner/repo --state open
```
```

### Frontmatter Fields

The YAML frontmatter between `---` delimiters is parsed to extract skill metadata. The parser reads simple `key: value` lines from the frontmatter block.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Skill identifier. Should match the folder name. |
| `description` | string | Yes | What the skill does. Shown to the agent and in the UI. |
| `required-os` | string[] | No | Restrict to specific platforms: `macos`, `linux`, `windows`. |
| `required-bins` | string[] | No | CLI tools that must exist in `PATH` for the skill to load. |
| `required-env` | string[] | No | Environment variables that must be set. |
| `user-invocable` | boolean | No | Whether users can invoke the skill directly. Default: `true`. |
| `disable-model-invocation` | boolean | No | If `true`, the skill content is not injected into prompts. |
| `primary-env` | string | No | Primary runtime environment: `node`, `python`, `shell`. |
| `command-dispatch` | string | No | How commands are dispatched (e.g., `shell`). |
| `command-tool` | string | No | Tool used for command execution (e.g., `bash`). |
| `metadata` | object | No | Arbitrary additional data (JSON object). |

**Parsing behavior:** The frontmatter parser extracts `name` and `description` from simple `key: value` lines. If the frontmatter is missing or malformed, Eliza falls back to reading the first markdown heading as the skill name and the first non-heading paragraph as the description.

---

## Skill Locations

Eliza discovers skills from multiple directories. Skills found in later (higher-precedence) directories override earlier ones with the same name.

### 1. Bundled Skills (lowest precedence)

Shipped with the `@elizaos/plugin-agent-skills` package. These are automatically available when the plugin is loaded. The bundled skills directory is resolved at startup via `getSkillsDir()` and passed to the runtime as `BUNDLED_SKILLS_DIRS`.

### 2. Extra Directories

Additional directories configured in `~/.eliza/eliza.json`:

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "/path/to/shared-team-skills",
        "/path/to/another-skills-dir"
      ]
    }
  }
}
```

### 3. Managed Skills

Global user-level skills stored at:

```
~/.eliza/skills/
├── my-custom-skill/
│   └── SKILL.md
└── team-shared-skill/
    └── SKILL.md
```

The catalog file is also stored here at `~/.eliza/skills/catalog.json`.

### 4. Workspace Skills

Project-local skills in the agent's workspace directory:

```
~/.eliza/workspace/skills/
├── project-specific-skill/
│   └── SKILL.md
└── override-bundled-skill/
    └── SKILL.md
```

### 5. Marketplace Skills (highest precedence)

Skills installed from the marketplace are placed under:

```
~/.eliza/workspace/skills/.marketplace/
├── content-marketer/
│   ├── SKILL.md
│   └── .scan-results.json
└── seo-optimizer/
    ├── SKILL.md
    └── .scan-results.json
```

Install records are tracked in `~/.eliza/workspace/skills/.cache/marketplace-installs.json`.

---

## Skill Loading Priority

When two skills share the same name, the higher-precedence source wins. The full resolution order (lowest to highest):

1. **Bundled skills** -- from `@elizaos/plugin-agent-skills`
2. **Extra directories** -- from `skills.load.extraDirs` config
3. **Managed skills** -- from `~/.eliza/skills/`
4. **Workspace skills** -- from `{workspace}/skills/`
5. **Marketplace skills** -- from `{workspace}/skills/.marketplace/`

### Enable/Disable Priority

Whether a skill is active is determined by this cascade (highest priority first):

1. **Database preferences** -- per-agent toggle set via the API (`POST /api/skills/:id/enable` or `POST /api/skills/:id/disable`)
2. **`skills.denyBundled`** -- config deny list, always blocks
3. **`skills.entries[id].enabled`** -- per-skill config flag
4. **`skills.allowBundled`** -- config allow list (whitelist mode: only listed skills load)
5. **Default** -- enabled

Configuration example in `~/.eliza/eliza.json`:

```json
{
  "skills": {
    "allowBundled": ["github", "weather", "coding-agent"],
    "denyBundled": ["deprecated-skill"],
    "entries": {
      "github": { "enabled": true },
      "noisy-skill": { "enabled": false }
    }
  }
}
```

---

## Skill Marketplace

The skill marketplace allows you to search for, install, and manage community-published skills. The default marketplace is [ClawHub](https://clawhub.ai).

### Marketplace Configuration

The marketplace URL is resolved from environment variables in this order:

1. `SKILLS_REGISTRY`
2. `CLAWHUB_REGISTRY`
3. `SKILLS_MARKETPLACE_URL`
4. Default: `https://clawhub.ai`

If no registry is configured, Eliza automatically sets `SKILLS_REGISTRY=https://clawhub.ai` at startup.

For the legacy SkillsMP marketplace, set the `SKILLSMP_API_KEY` environment variable:

```bash
export ELIZA_SKILLSMP_API_KEY="your-api-key"
```

### Searching the Marketplace

**Via the API:**

```
GET /api/skills/marketplace/search?q=content+marketing&limit=20
```

The search endpoint queries the configured marketplace registry and returns results with name, description, repository URL, tags, and relevance score.

**Response shape:**

```json
{
  "ok": true,
  "results": [
    {
      "id": "content-marketer",
      "slug": "content-marketer",
      "name": "Content Marketer",
      "description": "Generate blog posts and social media content",
      "repository": "owner/repo",
      "githubUrl": "https://github.com/owner/repo",
      "path": "skills/content-marketer",
      "tags": ["marketing", "content"],
      "score": 0.95,
      "source": "clawhub"
    }
  ]
}
```

### Installing from the Marketplace

There are two installation paths:

**1. By slug (ClawHub catalog install):**

```
POST /api/skills/marketplace/install
Content-Type: application/json

{ "slug": "content-marketer" }
```

This uses the `AgentSkillsService.install()` method, which resolves the skill from the catalog and installs it into the managed skills directory.

**2. By GitHub URL or repository (git-based install):**

```
POST /api/skills/marketplace/install
Content-Type: application/json

{
  "githubUrl": "https://github.com/owner/repo/tree/main/skills/my-skill",
  "name": "my-skill",
  "source": "clawhub"
}
```

Or by repository and path:

```
POST /api/skills/marketplace/install
Content-Type: application/json

{
  "repository": "owner/repo",
  "path": "skills/my-skill"
}
```

The git-based installer performs a **shallow sparse checkout** of only the skill directory (not the entire repository), copies it to `{workspace}/skills/.marketplace/{id}/`, validates that `SKILL.md` exists, and runs a security scan.

**Skill path auto-detection:** If no path is provided, the installer probes the repository for:
1. A `SKILL.md` at the repository root
2. Subdirectories under `skills/` that contain `SKILL.md`

### Listing Installed Marketplace Skills

```
GET /api/skills/marketplace/installed
```

Returns all skills installed via the marketplace, sorted by install date (newest first). Each entry includes the skill ID, source repository, install path, install timestamp, and security scan status.

### Uninstalling Marketplace Skills

```
POST /api/skills/marketplace/uninstall
Content-Type: application/json

{ "id": "content-marketer" }
```

The uninstaller verifies the skill's install path is within the expected `.marketplace` directory before removing it, preventing path traversal attacks. The install record is also removed from `marketplace-installs.json`.

---

## Security Scanning

Every skill installed from the marketplace is automatically scanned before it becomes available. The scan checks for structural attacks at the install boundary.

### What Is Scanned

| Check | Severity | Description |
|-------|----------|-------------|
| Binary files | `critical` | Detects executable files (`.exe`, `.dll`, `.so`, `.dylib`, `.wasm`, `.bin`, `.com`, `.bat`, `.cmd`) |
| Symlink escapes | `critical` | Detects symbolic links pointing outside the skill directory |
| Missing `SKILL.md` | `critical` | Validates the skill package has the required entry file |

### Scan Statuses

| Status | Meaning |
|--------|---------|
| `clean` | No issues found |
| `warning` | Non-critical warnings detected |
| `critical` | Critical findings but not blocking |
| `blocked` | Skill is rejected and removed from disk |

### Blocking Behavior

If a scan returns `blocked` status (binary files, symlink escapes, or missing `SKILL.md`), the skill directory is **automatically deleted** and the install fails with an error:

```
Skill "bad-skill" blocked by security scan: Binary executable file detected (.exe); Symbolic link points outside skill directory
```

### Scan Reports

Scan results are persisted as `.scan-results.json` inside the skill directory:

```json
{
  "scannedAt": "2026-02-19T12:00:00.000Z",
  "status": "clean",
  "summary": {
    "scannedFiles": 5,
    "critical": 0,
    "warn": 0,
    "info": 0
  },
  "findings": [],
  "manifestFindings": [],
  "skillPath": "/Users/you/.eliza/workspace/skills/.marketplace/my-skill"
}
```

You can retrieve a skill's scan report via the API:

```
GET /api/skills/:id/scan
```

The full content-level scan (code and markdown pattern analysis) is performed by the `AgentSkillsService` when it loads the skill. The marketplace scanner handles structural checks at install time.

---

## Skill Catalog

The skill catalog provides a local, cached index of all available skills from the registry. It enables fast browsing and searching without hitting the network on every request.

### How the Catalog Works

1. **File-based cache:** The catalog is stored as `catalog.json` and loaded from disk
2. **Memory cache:** Once loaded, skills are cached in memory for 10 minutes (`MEMORY_TTL_MS = 600_000`)
3. **Lazy loading:** The catalog is read on first access, not at startup

### Catalog File Locations

The catalog client checks these paths in order:

1. `ELIZA_SKILLS_CATALOG` environment variable (if set, used exclusively)
2. `skills/.cache/catalog.json` relative to the package root (walks up to 5 parent directories)
3. `~/.eliza/skills/catalog.json` (home directory fallback)

### Catalog Entry Shape

Each catalog skill contains:

```typescript
{
  slug: string;           // Unique identifier
  displayName: string;    // Human-readable name
  summary: string | null; // Short description
  tags: Record<string, string>;
  stats: {
    comments: number;
    downloads: number;
    installsAllTime: number;
    installsCurrent: number;
    stars: number;
    versions: number;
  };
  createdAt: number;      // Unix timestamp
  updatedAt: number;
  latestVersion: {
    version: string;
    createdAt: number;
    changelog: string;
  } | null;
}
```

### Catalog API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/skills/catalog` | GET | Browse the full catalog (paginated) |
| `/api/skills/catalog/search?q=query` | GET | Search skills by name, summary, tags |
| `/api/skills/catalog/:slug` | GET | Get a single skill by slug |
| `/api/skills/catalog/refresh` | POST | Force-refresh the catalog from disk |
| `/api/skills/catalog/install` | POST | Install a catalog skill by slug |
| `/api/skills/catalog/uninstall` | POST | Uninstall a catalog skill by slug |

### Catalog Search Scoring

Local search uses fuzzy matching across multiple fields with weighted scoring:

| Match Type | Score |
|------------|-------|
| Exact slug or name match | +100 |
| Slug contains query | +50 |
| Name contains query | +45 |
| Summary contains query | +30 |
| Tag contains query | +20 |
| Per-term slug match | +15 |
| Per-term name match | +12 |
| Per-term summary match | +8 |
| Popularity boost (downloads > 50) | +3 |
| Popularity boost (downloads > 200) | +3 |
| Stars boost (stars > 0) | +2 |
| Active installs boost | +2 |

Results are sorted by score, then by download count for ties.

---

## Creating Custom Skills

### Directory Structure

```
my-skill/
├── SKILL.md              # Required -- frontmatter + instructions
├── scripts/              # Optional -- executable scripts
│   └── setup.sh
├── references/           # Optional -- additional docs to load
│   └── api-reference.md
└── assets/               # Optional -- templates, config files
    └── template.json
```

### Step 1: Create the Skill Directory

For a workspace-local skill:

```bash
mkdir -p ~/.eliza/workspace/skills/my-tool
```

For a globally available skill:

```bash
mkdir -p ~/.eliza/skills/my-tool
```

### Step 2: Write SKILL.md

```markdown
---
name: my-tool
description: "Use my-tool CLI for data processing"
required-bins:
  - my-tool
required-env:
  - MY_TOOL_API_KEY
---

# My Tool Skill

This skill teaches you how to use the `my-tool` CLI.

## Authentication

Set your API key:

```bash
export MY_TOOL_API_KEY="your-key-here"
```

## Basic Usage

### List Items

```bash
my-tool list --format json
```

### Create Item

```bash
my-tool create --name "New Item" --type standard
```

## Error Handling

- **401 Unauthorized**: Check MY_TOOL_API_KEY is set correctly
- **404 Not Found**: Verify the item ID exists
- **429 Rate Limited**: Wait 60 seconds and retry
```

### Step 3: Add Scripts (Optional)

```bash
#!/bin/bash
# scripts/setup.sh
set -e

echo "Checking my-tool installation..."
if ! command -v my-tool &> /dev/null; then
    echo "Installing my-tool..."
    bun install -g my-tool
fi

echo "my-tool is ready!"
```

### Step 4: Verify the Skill Loads

Refresh the skills list to confirm your skill is discovered:

```
POST /api/skills/refresh
```

Or restart the agent and check:

```
GET /api/skills
```

Your skill should appear in the response with the name and description from your frontmatter.

---

## Writing a New Skill: Complete Example

Here is a complete example of a `code-review` skill that helps agents review pull requests.

### Full Directory Structure

```
code-review/
├── SKILL.md              # Required -- skill definition
├── scripts/
│   └── review.sh         # Optional -- executable helper
├── references/
│   └── review-checklist.md  # Optional -- loaded into context
└── assets/
    └── report-template.md   # Optional -- output template
```

### Complete SKILL.md

```markdown
---
name: code-review
description: Review pull requests for code quality, security issues, and best practices
required-bins: gh, git
required-env: GITHUB_TOKEN
user-invocable: true
primary-env: shell
command-dispatch: shell
command-tool: bash
metadata:
  category: development
  author: your-name
---

# Code Review Skill

Review a GitHub pull request for quality and security issues.

## Instructions

When asked to review a PR:

1. Fetch the PR diff using `gh pr diff <number>`
2. Analyze each changed file for:
   - Logic errors or bugs
   - Security vulnerabilities (injection, auth bypass, secrets exposure)
   - Performance issues (N+1 queries, unnecessary allocations)
   - Style violations (naming, formatting, dead code)
3. Load the review checklist from `references/review-checklist.md`
4. Generate a report using the template in `assets/report-template.md`
5. Post the review as a PR comment using `gh pr review <number>`

## Examples

User: "Review PR #42"
Agent: Fetches diff, analyzes changes, posts review comment

User: "Review the latest PR on eliza-ai/eliza"
Agent: Finds latest PR, reviews it
```

### Frontmatter Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | `string` | Skill identifier, must match folder name |
| `description` | Yes | `string` | What the skill does (shown in search results) |
| `required-os` | No | `string[]` | Platform restrictions: `macos`, `linux`, `windows` |
| `required-bins` | No | `string[]` | CLI tools that must be in PATH |
| `required-env` | No | `string[]` | Environment variables that must be set |
| `primary-env` | No | `string` | Runtime: `node`, `python`, `shell` |
| `user-invocable` | No | `boolean` | Can users invoke directly? Default: `true` |
| `disable-model-invocation` | No | `boolean` | If `true`, not injected into LLM prompts |
| `command-dispatch` | No | `string` | How commands are dispatched (e.g., `shell`) |
| `command-tool` | No | `string` | Tool for command execution (e.g., `bash`) |
| `metadata` | No | `object` | Arbitrary JSON (category, author, tags, etc.) |

### When to Use Scripts vs References vs Assets

| Directory | Purpose | Loaded When |
|-----------|---------|-------------|
| `scripts/` | Executable code the agent runs | Agent decides to execute during task |
| `references/` | Documentation loaded into agent context | Always loaded when skill is active |
| `assets/` | Templates, images, data files for output | Agent reads when generating output |

**Guidelines:**
- Keep `references/` files concise -- they consume context window tokens
- Put large datasets in `assets/`, not `references/`
- Scripts should be idempotent and safe to re-run
- Always include error handling in scripts

### Skill Resolution & Priority

Skills are discovered from multiple locations. When duplicate names exist, higher-priority sources win:

1. **Marketplace skills** (`{workspace}/skills/.marketplace/`) -- highest
2. **Workspace skills** (`{workspace}/skills/`)
3. **Managed skills** (`~/.eliza/skills/`)
4. **Extra directories** (from `skills.load.extraDirs` config)
5. **Bundled skills** (from `@elizaos/plugin-agent-skills`) -- lowest

### Enable/Disable Priority

1. Database preferences (per-agent toggle via API) -- highest
2. `skills.denyBundled` config (always blocks listed skills)
3. `skills.entries[id].enabled` config flag
4. `skills.allowBundled` config (whitelist mode)
5. Default: enabled -- lowest

### Skills vs Plugins: When to Use Each

| Use a **Skill** when... | Use a **Plugin** when... |
|------------------------|------------------------|
| Extending agent behavior with instructions | Adding new API integrations |
| No custom TypeScript code needed | Custom services, routes, or models |
| Markdown-based knowledge is sufficient | Need database access or state management |
| Rapid iteration (edit markdown, reload) | Need type-safe interfaces and testing |
| Context-window-friendly additions | Need background processes |

For a complete comparison of all extension points, see the [Decision Guide](/plugins/decision-guide).

---

## Best Practices

### Keep Instructions Concise

Skill content is injected into the agent's context window. Be thorough but not verbose:

```markdown
<!-- Concise and actionable -->
## Listing Files

```bash
ls -la           # All files, long format
ls -lh *.txt     # Text files with human-readable sizes
```
```

### Provide Runnable Examples

Show actual commands, not just descriptions:

```markdown
<!-- Good: runnable example -->
```bash
gh issue list --repo owner/repo --search "bug" --state open
```
```

### Declare Requirements in Frontmatter

Do not assume tools are installed. Use `required-bins` and `required-env` so the agent knows what is needed:

```yaml
---
name: docker-skill
description: "Manage Docker containers"
required-bins:
  - docker
  - docker-compose
required-os:
  - macos
  - linux
---
```

### Handle Errors

Document common errors and their solutions so the agent can self-diagnose:

```markdown
## Troubleshooting

### "Permission denied"
```bash
chmod +x script.sh
```

### "Command not found"
```bash
brew install my-tool  # macOS
apt install my-tool   # Linux
```
```

### Test Your Skills

1. Read your `SKILL.md` and follow the instructions manually
2. Verify all commands work as written
3. Check that the frontmatter parses correctly (restart the agent, then `GET /api/skills`)
4. If the skill has requirements, test on a clean environment

---

## API Reference Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/skills` | GET | List all discovered skills with enabled state |
| `/api/skills/refresh` | POST | Re-scan skill directories and refresh the list |
| `/api/skills/:id/enable` | POST | Enable a skill (persisted per-agent, honors scan acknowledgments) |
| `/api/skills/:id/disable` | POST | Disable a skill (persisted per-agent) |
| `/api/skills/:id` | PUT | **Deprecated** — use `POST /api/skills/:id/enable` or `POST /api/skills/:id/disable` instead |
| `/api/skills/:id/scan` | GET | Get the security scan report for a skill |
| `/api/skills/catalog` | GET | Browse the full skill catalog |
| `/api/skills/catalog/search` | GET | Search the catalog |
| `/api/skills/catalog/:slug` | GET | Get a catalog skill by slug |
| `/api/skills/catalog/refresh` | POST | Force-refresh the catalog cache |
| `/api/skills/catalog/install` | POST | Install a skill from the catalog |
| `/api/skills/catalog/uninstall` | POST | Uninstall a catalog skill |
| `/api/skills/marketplace/search` | GET | Search the remote marketplace |
| `/api/skills/marketplace/installed` | GET | List marketplace-installed skills |
| `/api/skills/marketplace/install` | POST | Install from marketplace (git or slug) |
| `/api/skills/marketplace/uninstall` | POST | Uninstall a marketplace skill |
| `/api/skills/marketplace/config` | GET | Check marketplace API key status |
| `/api/skills/marketplace/config` | PUT | Set the marketplace API key |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ELIZA_SKILLS_CATALOG` | Override the catalog file path |
| `SKILLS_REGISTRY` | Marketplace registry URL (default: `https://clawhub.ai`) |
| `CLAWHUB_REGISTRY` | Alternative to `SKILLS_REGISTRY` |
| `SKILLS_MARKETPLACE_URL` | Alternative to `SKILLS_REGISTRY` |
| `SKILLSMP_API_KEY` | API key for the legacy SkillsMP marketplace |
| `ELIZA_STATE_DIR` | Override the base state directory (default: `~/.eliza`) |
| `BUNDLED_SKILLS_DIRS` | Set by runtime -- path to bundled skills |
| `WORKSPACE_SKILLS_DIR` | Set by runtime -- path to workspace skills |
| `EXTRA_SKILLS_DIRS` | Set by runtime -- comma-separated extra skill directories |
| `SKILLS_ALLOWLIST` | Set by runtime -- comma-separated allowed skill IDs |
| `SKILLS_DENYLIST` | Set by runtime -- comma-separated denied skill IDs |

---

## Skill Operations Runbook

### Setup Checklist

1. Verify the skills plugin is loaded: `GET /api/skills` should return a non-empty list.
2. For marketplace installs, confirm registry connectivity: `GET /api/skills/marketplace/config` should show `configured: true` or a reachable default registry.
3. For catalog browsing, confirm the catalog file exists at one of the expected paths (see [Catalog File Locations](#catalog-file-locations) above).
4. Ensure `~/.eliza/workspace/skills/` is writable for marketplace and workspace skill installs.
5. For legacy SkillsMP marketplace, set `SKILLSMP_API_KEY` in the environment.

### Failure Modes

**Catalog operations:**

- Catalog returns empty results:
  The catalog file may be missing or empty. Run `POST /api/skills/catalog/refresh` to force a reload from disk. If the file does not exist, check that the `@elizaos/plugin-agent-skills` package is installed (it ships the initial catalog).
- Catalog search returns no matches:
  Search uses fuzzy matching across slug, name, summary, and tags. Try broader search terms. Exact slug matches score highest.
- Catalog cache is stale:
  The in-memory cache expires after 10 minutes (`MEMORY_TTL_MS`). Force-refresh with `POST /api/skills/catalog/refresh` or restart the agent.

**Marketplace operations:**

- Marketplace search fails with network error:
  Confirm the registry URL is reachable. Check `SKILLS_REGISTRY`, `CLAWHUB_REGISTRY`, or `SKILLS_MARKETPLACE_URL` environment variables. The default is `https://clawhub.ai`.
- Git clone fails during marketplace install:
  The installer uses sparse checkout to fetch only the skill directory. Confirm the repository URL and path are valid. Check that `git` is available in `PATH` and network access to GitHub is not blocked.
- Security scan blocks install (`blocked` status):
  The scan detected binary files (`.exe`, `.dll`, `.so`, etc.), symlink escapes, or a missing `SKILL.md`. The skill directory is automatically deleted. Inspect the skill source repository to confirm it is safe before requesting the author fix the issue.
- Install fails with "already installed":
  A record for this skill ID already exists in `marketplace-installs.json`. Uninstall first with `POST /api/skills/marketplace/uninstall`, then retry.

**Skill loading:**

- Custom skill not appearing in `/api/skills`:
  Confirm the skill directory contains a valid `SKILL.md` with name/description frontmatter. Check that the directory is in a scanned location (bundled, managed, workspace, or marketplace). Run `POST /api/skills/refresh` to re-scan.
- Skill loads but is disabled:
  Check the enable/disable cascade: database preferences override config, `denyBundled` blocks unconditionally, `allowBundled` acts as a whitelist. Use `POST /api/skills/:id/enable` to force-enable.
- Required binary or env var missing:
  Skills with `required-bins` or `required-env` frontmatter are skipped if dependencies are absent. Install the required CLI tool or set the environment variable.

### Recovery Procedures

1. **Corrupted marketplace install:** Delete `~/.eliza/workspace/skills/.marketplace/<skill-id>/` and remove its entry from `~/.eliza/workspace/skills/.cache/marketplace-installs.json`, then re-install.
2. **Catalog file missing:** Re-install or update `@elizaos/plugin-agent-skills` to restore the bundled catalog. Alternatively, copy a known-good `catalog.json` to `~/.eliza/skills/catalog.json`.
3. **Skill override conflict:** If a workspace skill unexpectedly overrides a bundled skill, rename the workspace skill directory or move it to a different location. Higher-precedence sources always win.

### Verification Commands

```bash
# Skill catalog and marketplace unit tests
bunx vitest run src/services/skill-marketplace.test.ts src/services/skill-catalog-client.test.ts

# Skill marketplace e2e lifecycle
bunx vitest run --config test/vitest/e2e.config.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

bun run typecheck
```
