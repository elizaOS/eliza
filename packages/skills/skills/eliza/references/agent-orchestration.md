# Agent Orchestration

## What A Spawned Worker Gets

The agent orchestrator creates a PTY session for coding workers such as Claude, Codex, Gemini, Aider, shell/OpenCode-compatible sessions, and future agent runtimes. Each worker gets:

- a concrete working directory; all file edits and commands should happen there
- an injected memory file appropriate to the adapter, such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or `.aider.conventions.md`
- read-only loopback context endpoints under `/api/coding-agents/{sessionId}`
- a generated `SKILLS.md` manifest when the parent runtime has the skills service available
- an `ELIZA_SKILLS_MANIFEST` environment variable pointing at that manifest
- a hook channel that lets the parent observe lifecycle events and skill requests

The memory file always includes the workspace CWD and says to stay there. Treat that CWD as authoritative even if another repo path exists on disk.

## Reading Parent Runtime State

The parent runtime bridge memory gives exact loopback URLs for the current session:

- `GET /api/coding-agents/{sessionId}/parent-context` returns character, room, model preferences, and workdir
- `GET /api/coding-agents/{sessionId}/memory?q=<query>` searches parent memory for matching entities, facts, messages, and knowledge
- `GET /api/coding-agents/{sessionId}/active-workspaces` lists known workspaces and task-agent sessions

These are read-only. Do not invent POST calls against these endpoints.

## Calling Back To The Parent Agent

When `SKILLS.md` lists `parent-agent`, the worker can ask the running parent Eliza agent to use any capability it has loaded. Emit the directive on its own line:

```text
USE_SKILL parent-agent {"request":"Find the next open 30 minute calendar slot tomorrow afternoon and summarize the result"}
```

The bridge sends that request through the parent's normal message pipeline. The parent can call actions, providers, connectors, services, model handlers, or ask the user to confirm. Results are sent back into the same worker session between:

```text
--- USE_SKILL response (parent-agent, ok) ---
...
--- End USE_SKILL response ---
```

To inspect the action surface before asking:

```text
USE_SKILL parent-agent {"mode":"list-actions","query":"calendar","limit":25}
```

The orchestrator also exposes deterministic Cloud commands for account-bound
Eliza Cloud actions. Prefer these when the worker knows the exact API operation:

```text
USE_SKILL parent-agent {"mode":"list-cloud-commands","query":"x402"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.list"}
USE_SKILL parent-agent {"mode":"cloud-command","command":"domains.check","params":{"id":"<appId>","body":{"domain":"example.com"}}}
```

Paid, mutating, or destructive Cloud commands return `confirmation_required`
unless the parent/user has already approved the exact operation and the worker
passes `confirmed:true`. Examples include app creation, monetization changes,
charge/x402 creation, domain buying, media generation, promotion execution,
advertising campaign creation/start, and payout/redemption creation.

Use specific requests. Include enough context for the parent to choose the right action and return a useful answer.

## Task-Scoped Brokers

Some brokers are virtual skills handled by the orchestrator rather than disk-backed `SKILL.md` files:

- `parent-agent` asks the parent runtime to act or answer through its loaded capabilities.
- `lifeops-context` returns structured LifeOps task context when the spawned task is tied to a LifeOps `ScheduledTask`.

Sensitive brokers are only available when the orchestrator allow-lists them for the session. If a broker is not in `SKILLS.md`, do not rely on it.

## What To Ask The Parent For

Ask the parent when the information or action lives outside the local checkout:

- calendar availability, reminders, approvals, LifeOps task state, or user preferences
- GitHub, browser, email, workspace, or connector actions available to the parent agent
- Cloud account state such as apps, credits, domains, containers, analytics, or earnings
- paid Cloud actions such as domain buys, ad spend, app charge requests, x402
  payment requests, credit top-ups, or public promotion posts
- private memory, prior user decisions, active room context, or persona state
- paid or destructive operations that require user confirmation

Do not ask the parent to do ordinary local file reads, tests, or edits when the worker can do them directly in the workspace.

## Decision And Confirmation Flow

The parent agent may refuse, request user confirmation, or return partial data. Continue from the returned result. For paid/destructive operations, the worker should never bypass confirmation; ask the parent to perform the confirmation flow and relay the result.

If work cannot proceed without a human choice, print:

```text
DECISION: <the exact decision needed and why>
```

The orchestrator watches for that pattern.
