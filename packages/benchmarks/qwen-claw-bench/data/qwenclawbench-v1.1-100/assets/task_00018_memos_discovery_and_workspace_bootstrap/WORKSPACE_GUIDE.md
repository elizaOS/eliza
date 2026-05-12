# Workspace Bootstrap Guide

Welcome to the OpenClaw workspace! This guide describes the standard setup procedure for initializing a new agent workspace.

## Initialization Checklist

When setting up a fresh workspace, the following steps should be completed:

### 1. Version Control
- Initialize a git repository (`git init`)
- Ensure `.git/HEAD` and `.git/config` are present

### 2. Core Identity Files
Create the following files in the workspace root:

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Defines the agent's identity, name, and core purpose |
| `SOUL.md` | Describes the agent's personality, values, and behavioral principles |
| `USER.md` | Profile of the primary user — preferences, communication style, goals |

### 3. Documentation Files
| File | Purpose |
|------|---------|
| `BOOTSTRAP.md` | Log of workspace initialization steps and status |
| `AGENTS.md` | Registry of available agents and their capabilities |
| `TOOLS.md` | Inventory of tools, CLIs, and integrations available in this environment |
| `HEARTBEAT.md` | Periodic status/health log — updated on each session or check-in |

### 4. State Tracking
- Create `.openclaw/workspace-state.json` with the current workspace configuration
- This file should be valid JSON containing at minimum:
  - `initialized`: boolean
  - `initialized_at`: ISO 8601 timestamp
  - `files_created`: list of files created during bootstrap

## Example workspace-state.json

```json
{
  "initialized": true,
  "initialized_at": "2026-02-10T08:00:00Z",
  "files_created": [
    "IDENTITY.md",
    "SOUL.md",
    "USER.md",
    "BOOTSTRAP.md",
    "AGENTS.md",
    "TOOLS.md",
    "HEARTBEAT.md"
  ],
  "version": "1.0.0"
}
```

## Notes

- Each file should contain meaningful content relevant to its purpose, not just empty placeholders
- The workspace may already contain existing skills and configurations — review them as part of the bootstrap process
- After bootstrap, update HEARTBEAT.md with the current session status