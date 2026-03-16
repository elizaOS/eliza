# @elizaos/plugin-lobster

Lobster workflow runtime plugin for elizaOS. Enables deterministic multi-step pipelines with approval checkpoints.

## Overview

Lobster executes multi-step workflows as a local-first runtime with typed JSON envelopes and resumable approvals. This plugin integrates Lobster into elizaOS agents.

## When to Use Lobster

| User Intent | Use Lobster? |
|-------------|--------------|
| "Triage my email" | Yes — multi-step, may send replies |
| "Send a message" | No — single action, use message tool directly |
| "Check my email every morning and ask before replying" | Yes — scheduled workflow with approval |
| "What's the weather?" | No — simple query |
| "Monitor this PR and notify me of changes" | Yes — stateful, recurring |

## Installation

```bash
npm install @elizaos/plugin-lobster
```

**Prerequisite:** Lobster CLI must be installed and available in PATH.

## Usage

Add the plugin to your agent configuration:

```typescript
import { lobsterPlugin } from "@elizaos/plugin-lobster";

const agent = {
  // ... other config
  plugins: [lobsterPlugin],
};
```

## Actions

### LOBSTER_RUN

Run a Lobster pipeline for deterministic, multi-step workflows.

**Similes**: RUN_PIPELINE, EXECUTE_WORKFLOW, START_AUTOMATION

**Example**:
```
User: "Triage my email from the last day"
Agent: "Running the email triage pipeline..."

Pipeline: gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage
```

**Returns**: JSON envelope with status and output:
- `ok: true, status: "ok"` — Pipeline completed
- `ok: true, status: "needs_approval"` — Awaiting user decision
- `ok: true, status: "cancelled"` — User cancelled
- `ok: false, error: {...}` — Pipeline failed

### LOBSTER_RESUME

Resume a paused pipeline after an approval checkpoint.

**Similes**: APPROVE_WORKFLOW, CONTINUE_PIPELINE, RESUME_AUTOMATION

**Example**:
```
Agent: "The pipeline wants to send 3 draft replies. Approve?"
User: "Yes, go ahead"
Agent: "Resuming with approval. Replies sent."
```

## Provider

### lobster

Provides information about Lobster availability and help text. The provider injects context about available pipeline commands when Lobster is installed.

## Pipeline Syntax

Lobster pipelines are shell-like commands:

```bash
# Email triage
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage

# PR review
github.pr.list --state open | pr.review

# With approval gate
gog.gmail.search --query 'newer_than:1d' | email.triage | approve --prompt 'Process these?'
```

## Key Behaviors

- **Deterministic**: Same input → same output
- **Approval gates**: Halts execution, returns token
- **Resumable**: Continue with `LOBSTER_RESUME` action
- **Structured output**: JSON envelope with `ok`, `status`, `output`

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| LOBSTER_PATH | string | "lobster" | Path to lobster executable |
| LOBSTER_TIMEOUT_MS | number | 20000 | Default timeout in milliseconds |

## Development

```bash
# Build
bun run build

# Type check
bun run typecheck

# Lint
bun run lint
```

## License

MIT
