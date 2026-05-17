---
title: "Skills API"
sidebarTitle: "Skills"
description: "REST API endpoints for managing local skills, the skills catalog, and the skills marketplace."
---

The skills API covers three areas: **local skills** (markdown-based SKILL.md extensions that teach the agent task-specific procedures), the **skills catalog** (curated registry of community skills), and the **skills marketplace** (git-based skill packages). Skills are injected into the agent's context at runtime to guide its behavior.

When `ELIZA_API_TOKEN` is set, include it as a `Bearer` token in the `Authorization` header.

## Endpoints

### Local Skills

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills` | List all local skills with metadata |
| POST | `/api/skills/refresh` | Re-scan the skills directory |
| GET | `/api/skills/:id/scan` | Scan a skill file and return parsed metadata |
| POST | `/api/skills/create` | Create a new skill file from a template |
| POST | `/api/skills/:id/open` | Open a skill file in the default editor |
| GET | `/api/skills/:id/source` | Read the source code of a skill |
| PUT | `/api/skills/:id/source` | Write updated source code for a skill |
| POST | `/api/skills/:id/acknowledge` | Acknowledge a skill security scan |
| POST | `/api/skills/:id/enable` | Enable a skill (honors scan acknowledgments) |
| POST | `/api/skills/:id/disable` | Disable a skill |
| POST | `/api/skills/:id/acknowledge` | Acknowledge a skill security scan |
| DELETE | `/api/skills/:id` | Delete a skill |

### Skills Catalog

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills/catalog` | List the skills catalog with pagination |
| GET | `/api/skills/catalog/search` | Search the catalog by query |
| GET | `/api/skills/catalog/:id` | Get details for a single catalog entry |
| POST | `/api/skills/catalog/refresh` | Refresh the catalog from the remote registry |
| POST | `/api/skills/catalog/install` | Install a catalog skill |
| POST | `/api/skills/catalog/uninstall` | Uninstall a catalog skill |

### Skills Marketplace

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/skills/marketplace/search` | Search the npm marketplace for skills |
| GET | `/api/skills/marketplace/installed` | List installed marketplace skills |
| POST | `/api/skills/marketplace/install` | Install a skill from npm |
| POST | `/api/skills/marketplace/uninstall` | Uninstall a marketplace skill |
| GET | `/api/skills/marketplace/config` | Get marketplace configuration |
| PUT | `/api/skills/marketplace/config` | Update marketplace configuration |

---

## Local Skills

### GET /api/skills

List all local skills found in the agent's skills directory. Each entry includes the file path, parsed action metadata, and enabled/priority preferences.

**Response**

```json
{
  "skills": [
    {
      "id": "my-custom-action",
      "name": "MY_CUSTOM_ACTION",
      "description": "Does something useful",
      "filePath": "/path/to/skills/my-custom-action.ts",
      "enabled": true,
      "priority": 0,
      "valid": true,
      "scanStatus": "clean"
    }
  ]
}
```

---

### POST /api/skills/refresh

Re-scan the skills directory and reload all skill metadata. Useful after manually adding or editing skill files.

**Response**

```json
{
  "skills": [
    {
      "id": "my-custom-action",
      "name": "MY_CUSTOM_ACTION",
      "description": "Does something useful",
      "enabled": true,
      "scanStatus": "clean"
    }
  ]
}
```

---

### GET /api/skills/:id/scan

Scan a single skill file and return its parsed AST metadata — exported actions, providers, and evaluators.

**Response**

```json
{
  "id": "my-skill",
  "actions": [
    {
      "name": "MY_ACTION",
      "description": "Action description",
      "similes": ["DO_THING"],
      "parameters": []
    }
  ],
  "providers": [],
  "evaluators": []
}
```

---

### POST /api/skills/create

Create a new skill file from a built-in template.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Skill file name (e.g. `my-action`) |
| `template` | string | No | Template to use — defaults to a basic action template |

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-action",
    "filePath": "/path/to/skills/my-action.ts"
  }
}
```

---

### POST /api/skills/:id/open

Open the skill file in the system's default code editor.

**Response**

```json
{
  "ok": true
}
```

---

### GET /api/skills/:id/source

Read the raw TypeScript source code of a skill file.

**Response**

```json
{
  "id": "my-skill",
  "source": "import { Action } from '@elizaos/core';\n\nexport const myAction: Action = { ... };"
}
```

---

### PUT /api/skills/:id/source

Write updated source code to a skill file. The server validates basic syntax before saving.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | Yes | The new TypeScript source code |

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/skills/:id/enable

Enable an installed skill. Returns 409 if the skill has unacknowledged scan findings — acknowledge via `POST /api/skills/:id/acknowledge` first.

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": true
  },
  "scanStatus": null
}
```

---

### POST /api/skills/:id/disable

Disable an installed skill.

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": false
  },
  "scanStatus": null
}
```

---

### DELETE /api/skills/:id

Delete a skill and remove its files from the skills directory.

**Response**

```json
{
  "ok": true
}
```

**Errors:** `404` skill not found.

---

## Skills Catalog

### GET /api/skills/catalog

Browse the curated skills catalog with pagination and sorting.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `perPage` | number | 50 | Items per page (max 100) |
| `sort` | string | `downloads` | Sort field |

**Response**

```json
{
  "skills": [
    {
      "id": "greeting-skill",
      "name": "Greeting Skill",
      "description": "Custom greeting actions",
      "author": "community",
      "downloads": 1234,
      "installed": false
    }
  ],
  "total": 42,
  "page": 1,
  "perPage": 50
}
```

---

### GET /api/skills/catalog/search

Search the catalog by text query.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query (required) |
| `limit` | number | Max results (default 30, max 100) |

**Response**

```json
{
  "skills": [ ... ],
  "total": 5
}
```

---

### GET /api/skills/catalog/:id

Get full details for a single catalog skill entry.

**Response**

```json
{
  "skill": {
    "id": "greeting-skill",
    "name": "Greeting Skill",
    "description": "Full description...",
    "author": "community",
    "version": "1.0.0",
    "installed": false,
    "readme": "# Greeting Skill\n..."
  }
}
```

---

### POST /api/skills/catalog/refresh

Force-refresh the catalog from the remote registry.

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/skills/catalog/install

Install a skill from the catalog.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Catalog skill ID |

**Response**

```json
{
  "ok": true,
  "skill": { "id": "greeting-skill", "installed": true }
}
```

---

### POST /api/skills/catalog/uninstall

Uninstall a previously installed catalog skill.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Catalog skill ID |

**Response**

```json
{
  "ok": true
}
```

---

## Skills Marketplace

### GET /api/skills/marketplace/search

Search the npm-based skills marketplace.

**Query Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query |
| `limit` | number | Max results (default 30, max 100) |

**Response**

```json
{
  "results": [
    {
      "name": "@community/skill-weather",
      "description": "Weather lookup skill",
      "version": "2.1.0"
    }
  ]
}
```

---

### GET /api/skills/marketplace/installed

List all marketplace skills currently installed.

**Response**

```json
{
  "skills": [
    {
      "name": "@community/skill-weather",
      "version": "2.1.0",
      "installedAt": "2025-06-01T12:00:00Z"
    }
  ]
}
```

---

### POST /api/skills/marketplace/install

Install a skill package from the npm marketplace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | npm package name |
| `version` | string | No | Specific version (defaults to latest) |

**Response**

```json
{
  "ok": true
}
```

---

### POST /api/skills/marketplace/uninstall

Uninstall a marketplace skill package.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | npm package name |

**Response**

```json
{
  "ok": true
}
```

---

### GET /api/skills/marketplace/config

Get the current marketplace configuration.

**Response**

```json
{
  "config": { ... }
}
```

---

### PUT /api/skills/marketplace/config

Update the marketplace configuration.

**Request Body**

Arbitrary configuration object — varies by marketplace backend.

**Response**

```json
{
  "ok": true
}
```

## Acknowledge Skill Findings

```
POST /api/skills/:id/acknowledge
```

Acknowledges the security scan findings for a skill. Required before the skill can be enabled. Optionally enables the skill in the same request.

**Path params:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Skill slug |

**Request body:**
```json
{ "enable": true }
```

`enable` is optional — omit or set to `false` to acknowledge without enabling.

**Response — findings present:**
```json
{
  "ok": true,
  "skillId": "my-skill",
  "acknowledged": true,
  "enabled": true,
  "findingCount": 3
}
```

**Response — no findings (clean scan):**
```json
{
  "ok": true,
  "message": "No findings to acknowledge.",
  "acknowledged": true
}
```

**Errors:** `404` no scan report found; `403` skill status is `"blocked"` (cannot be acknowledged).

---

## Skills Catalog and Marketplace Runbook

### Setup Checklist

1. Confirm skills directory (`~/.eliza/workspace/skills/`) is readable and writable by the runtime.
2. Confirm marketplace registry/network access is available (default: `https://clawhub.ai`). Check `SKILLS_REGISTRY`, `CLAWHUB_REGISTRY`, or `SKILLS_MARKETPLACE_URL` environment variables.
3. Confirm plugin installer prerequisites (`bun` and `git`) are present in runtime PATH.
4. For legacy SkillsMP marketplace, set `SKILLSMP_API_KEY` in the environment.
5. Verify the catalog file exists at one of the expected paths (bundled with `@elizaos/plugin-agent-skills`).

### Failure Modes

**Search and catalog:**

- Search returns empty unexpectedly:
  Check query input, upstream registry availability, and rate limiting. Fuzzy matching uses slug, name, summary, and tags — try broader search terms.
- Catalog cache is stale:
  The in-memory cache expires after 10 minutes. Force-refresh with `POST /api/skills/catalog/refresh` or restart the agent.

**Install and uninstall:**

- Install fails with network error:
  Check package name/version validity, installer permissions, and network. The installer uses sparse checkout for git-based installs — confirm `git` is available.
- Security scan blocks install (`blocked` status):
  The scan detected binary files (`.exe`, `.dll`, `.so`), symlink escapes, or a missing `SKILL.md`. The skill directory is automatically deleted.
- Install fails with "already installed":
  A record for this skill ID already exists. Uninstall first with `POST /api/skills/marketplace/uninstall`, then retry.
- Uninstall leaves stale state:
  Refresh skills list and verify the package is removed from `marketplace-installs.json`.

**Skill loading:**

- Custom skill not appearing in `/api/skills`:
  Confirm the skill directory contains a valid `SKILL.md` with name/description frontmatter. Run `POST /api/skills/refresh` to re-scan.
- Skill loads but is disabled:
  Check the enable/disable cascade: database preferences override config, `denyBundled` blocks unconditionally.

### Recovery Procedures

1. **Corrupted marketplace install:** Delete `~/.eliza/workspace/skills/.marketplace/<skill-id>/` and remove its entry from `~/.eliza/workspace/skills/.cache/marketplace-installs.json`, then re-install.
2. **Catalog file missing:** Re-install or update `@elizaos/plugin-agent-skills` to restore the bundled catalog.
3. **Skill override conflict:** If a workspace skill unexpectedly overrides a bundled skill, rename the workspace skill directory or move it to a different location.

### Verification Commands

```bash
# Skill catalog and marketplace unit tests
bunx vitest run src/services/plugin-installer.test.ts src/services/skill-marketplace.test.ts src/services/skill-catalog-client.test.ts

# Skills marketplace API and services e2e
bunx vitest run --config test/vitest/e2e.config.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

# API server e2e (includes skills routes)
bunx vitest run --config test/vitest/e2e.config.ts test/api-server.e2e.test.ts

bun run typecheck
```

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 500 | `SKILL_BLOCKED` | Skill is blocked due to security scan findings |
| 500 | `SYNTAX_ERROR` | Skill source code contains syntax errors |
| 500 | `ALREADY_INSTALLED` | Skill is already installed |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
