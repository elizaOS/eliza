# Eliza Browser App Harness

`scripts/eliza-browser-app-harness.mjs` is a Puppeteer-over-Eliza skeleton for
benchmarking browser-agent tasks through the Eliza app surface.

The harness has one hard boundary: it does not drive target websites. It creates
a normal Eliza conversation, sends a prompt instructing the agent to use its
built-in `BROWSER` action, then observes Eliza-owned APIs and the Eliza app UI.

## Quick Start

Dry-run the plan and artifact layout:

```sh
bun run harness:browser-app -- --dry-run --target-url https://example.com/
```

Attach to an already-running desktop/API stack:

```sh
bun run harness:browser-app -- \
  --no-launch \
  --target-url https://example.com/ \
  --prompt "Open the page and report its headline." \
  --timeout 90s
```

Launch the dev desktop stack if `/api/health` is not already reachable:

```sh
bun run harness:browser-app -- \
  --target-url https://example.com/ \
  --prompt "Open the page and summarize what the site is for." \
  --timeout 2m
```

Artifacts are written under:

```text
tmp/eliza-browser-harness/<run-id>/
```

## Flags

- `--dry-run`: write `run-plan.json` and exit without launching, prompting, or
  polling.
- `--no-launch`: require an already-running stack.
- `--prompt <text>`: task text to wrap in the harness BROWSER-action prompt.
- `--target-url <url>`: target URL for the agent's browser task.
- `--timeout <ms|s|m>`: total polling time after the prompt is sent.
- `--api-base <url>`: Eliza API base URL, default
  `http://127.0.0.1:31337`.
- `--ui-url <url>`: Eliza app URL for Puppeteer screenshots. If omitted, the
  harness uses `/api/dev/stack` and prefers `desktop.rendererUrl`, then
  `desktop.uiPort`.
- `--poll-interval <ms|s|m>`: polling cadence, default `2500ms`.
- `--run-id <id>`: artifact directory name.

Set `ELIZA_API_TOKEN` or `ELIZAOS_API_TOKEN` if the local API requires bearer
auth. Set `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH` if Chrome/Chromium is not
installed in a common location.

## What It Probes

Before prompting, the harness captures:

- `GET /api/health`
- `GET /api/status`
- `GET /api/dev/stack`

After creating a conversation and sending the task prompt, it polls:

- `GET /api/browser-workspace`
- `GET /api/browser-workspace/events`
- `GET /api/trajectories?limit=20&offset=0`
- `GET /api/dev/console-log?maxLines=400&maxBytes=256000`
- `GET /api/conversations/:id/messages`

`/api/browser-workspace/events` and `/api/dev/console-log` may return `404` on
some stacks. Those responses are recorded as artifacts rather than treated as
harness failures.

## Guardrails

The harness blocks these browser-workspace routes in its HTTP helper:

- `POST /api/browser-workspace/command`
- `POST /api/browser-workspace/tabs`
- `/api/browser-workspace/tabs/:id/navigate`
- `/api/browser-workspace/tabs/:id/eval`
- `/api/browser-workspace/tabs/:id/show`
- `/api/browser-workspace/tabs/:id/hide`

Puppeteer is only used to open the Eliza app UI URL and capture
`eliza-app-initial.png` / `eliza-app-final.png`. It does not click, type, or
navigate inside target websites.

## Artifact Map

Common files:

- `run-plan.json`: parsed options, guardrails, and final prompt text.
- `probe-health.json`, `probe-status.json`, `probe-dev-stack.json`: initial
  probe responses.
- `discovery.json`: resolved API/UI URLs and probe status summary.
- `conversation-create.json`: conversation creation response.
- `agent-prompt.json`: exact prompt sent to the agent.
- `conversation-prompt-response.json`: non-streaming chat response.
- `polls.jsonl`: every poll response, including tolerated `404`s.
- `browser-workspace-events.jsonl`: event endpoint poll subset.
- `poll-latest.json`: last response seen for each polled endpoint.
- `final-*.json` or `final-*.txt`: final endpoint captures.
- `eliza-app-initial.png`, `eliza-app-final.png`: Puppeteer screenshots when a
  Chrome executable is available.
- `summary.json`: final pass/fail status and run metadata.

If the harness launches `bun run dev:desktop`, child stdout/stderr are written
as `dev-desktop.stdout.jsonl` and `dev-desktop.stderr.jsonl`.
