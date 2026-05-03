---
title: Coding Swarms (Orchestrator)
sidebarTitle: Coding Swarms
description: How Eliza coding swarms work, how to enable/configure them, auth modes, debug capture, and benchmark basics.
---

Eliza's coding swarm capability is powered by `@elizaos/plugin-agent-orchestrator`.

## Is It Enabled By Default?

Yes. The orchestrator plugin is in Eliza's core plugin set and loads by default.

It is only disabled if you explicitly disable it in config.

Example (`~/.eliza/eliza.json`):

```json
{
  "plugins": {
    "entries": {
      "agent-orchestrator": { "enabled": true }
    }
  }
}
```

To disable:

```json
{
  "plugins": {
    "entries": {
      "agent-orchestrator": { "enabled": false }
    }
  }
}
```

## Architecture (High Level)

The orchestration stack has four main pieces:

- `CODE_TASK` compatibility service: task metadata/query surface exported by `@elizaos/plugin-agent-orchestrator`.
- `PTYService`: launches/manages local coding-agent terminal sessions.
- `SwarmCoordinator`: handles multi-agent supervision, turn triage, and completion.
- `CodingWorkspaceService`: provisions per-task Git workspaces.

In short: Eliza receives a coding request, provisions workspace(s), spawns one or more coding-agent sessions, coordinates progress, and reports back in chat/API.

## Scratch Workspace Lifecycle

When no `repo` and no explicit `workdir` are provided, the orchestrator creates a scratch workspace under:

- `~/.eliza/workspaces/<uuid>`

Current behavior: scratch is treated as temporary and is cleaned up automatically when the task reaches a terminal state (`task_complete`, `stopped`, or `error`).

For ongoing projects, do not rely on scratch. Use a persistent location instead (see next section).

## Persistent Local Projects (No Repo Required)

If users want multi-turn coding on local files over time, use an explicit `workdir` (persistent folder), not scratch.

By default, safety checks allow `workdir` only under:

- `~/.eliza/workspaces`
- the Eliza server process current working directory (`cwd`)

Recommended pattern:

1. Create a project folder under `~/.eliza/workspaces` (or under the directory where you launch Eliza).
2. Start coding tasks with that folder as `workdir`.
3. Reuse the same `workdir` across sessions.

This keeps data persistent without opening unrestricted filesystem access.

## Local Agent CLIs Must Be Installed

Eliza can orchestrate these agent types:

- `claude`
- `codex`
- `gemini`
- `aider`

Install the CLIs locally first, then verify from your shell:

```bash
claude --version
codex --version
gemini --version
aider --version
```

You can also check availability via API:

```http
GET /api/coding-agents/preflight
```

This is the source of truth for "is this agent available on this machine right now?"

## Credentials and Login Behavior

Eliza passes provider keys to coding-agent sessions when present:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY` (alias: `GOOGLE_API_KEY`)

Behavior when keys are missing depends on the agent CLI:

- `gemini`: supports API-key mode and Google login flow. If no key is set, orchestrator uses CLI auth flow.
- `claude` and `codex`: typically rely on each CLI's own login/subscription flow when API keys are not set.
- `aider`: typically requires provider API keys and does not rely on a subscription-style login in Eliza.

## GitHub Access for Repo/PR/Issue Work

For workspace cloning, issue/PR workflows, and GitHub API actions, configure one of:

- `GITHUB_TOKEN` (recommended for automation), or
- `GITHUB_OAUTH_CLIENT_ID` (OAuth device flow)

Optional:

- `GITHUB_OAUTH_CLIENT_SECRET`

If no `GITHUB_TOKEN` is set and `GITHUB_OAUTH_CLIENT_ID` is present, Eliza can run GitHub device auth and prompt you with a verification URL + code.

### Creating a GitHub OAuth App (Device Flow)

1. GitHub -> Settings -> Developer settings -> OAuth Apps.
2. Create a new OAuth App.
3. Copy Client ID.
4. Set `GITHUB_OAUTH_CLIENT_ID` in Eliza env/config.
5. Set `GITHUB_OAUTH_CLIENT_SECRET` only if your policy requires it.

## Debug Capture (Use Carefully)

Enable:

```bash
PARALLAX_DEBUG_CAPTURE=1
```

Capture files are written under:

- `.parallax/pty-captures/`

Important:

- Captures may include prompts, responses, tool inputs/outputs, terminal output, and other sensitive task context.
- Capture files grow quickly; use only for debugging/benchmark collection.
- Disable after use to avoid unnecessary disk growth and sensitive local logs.

## Benchmark Basics

For replay benchmark workflows, keep captures and normalized artifacts separate:

- raw captures: `.parallax/pty-captures/` (or exported into `captures/`)
- normalized replay artifacts: `replays/`

Reference: the solo-vs-swarm replay benchmark runbook is maintained in the repository for benchmark workflows.

Useful benchmark env vars:

- `PARALLAX_BENCHMARK_PREFLIGHT_AUTO=1`
- `PARALLAX_BENCHMARK_PREFLIGHT_MODE=cold|warm`
- `PARALLAX_BENCHMARK_PREFLIGHT_VENV=.benchmark-venv`

`cold` recreates venv/deps for clean comparisons. `warm` reuses existing venv when valid.
