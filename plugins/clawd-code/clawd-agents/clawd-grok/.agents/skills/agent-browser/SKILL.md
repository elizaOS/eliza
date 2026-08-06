---
name: agent-browser
description: Use the host-side `agent-browser` CLI for local browser smoke tests, screenshots, snapshots, and simple UI validation against forwarded localhost URLs.
---

# agent-browser

Use this skill when verification needs a real browser after the app is booted from the sandbox.

This project uses `agent-browser` on the host, not inside Shuru. The usual flow is:

1. Start the app with sandboxed bash.
2. Expose it through a forwarded localhost port.
3. Use `agent-browser` against that localhost URL.

## Requirements

- The `agent-browser` CLI must be installed and available on `PATH`.
- Prefer `http://127.0.0.1:<port>` or another explicit localhost URL.
- Use a named browser session when there is any chance of concurrent runs.

## Core flow

```bash
agent-browser --session verify open http://127.0.0.1:3000
agent-browser --session verify wait --load networkidle
agent-browser --session verify snapshot -i
```

After any click or navigation, re-snapshot before using old refs again.

## Common commands

```bash
# Open and wait for readiness
agent-browser --session verify open <url>
agent-browser --session verify wait --load networkidle

# Inspect the page
agent-browser --session verify snapshot -i
agent-browser --session verify get title
agent-browser --session verify get url

# Interact with elements from snapshot refs
agent-browser --session verify click @e1
agent-browser --session verify fill @e2 "text"
agent-browser --session verify press Enter

# Record the smoke test as video
agent-browser record start .grok/verify-artifacts/verify-smoke.webm

# Capture screenshot proof (use --screenshot-dir, not a positional path)
mkdir -p .grok/verify-artifacts
agent-browser --screenshot-dir .grok/verify-artifacts screenshot
agent-browser --screenshot-dir .grok/verify-artifacts screenshot --full

# Stop recording and clean up
agent-browser record stop
agent-browser close
```

## Guidance

- Keep browser checks narrow in phase 1: page load, one or two critical controls, and optional screenshot evidence.
- Save screenshots to stable workspace-relative paths under `.grok/verify-artifacts/` so verify can report them back to the user.
- Prefer `wait --load networkidle` after `open`.
- If the page is dynamic, use `snapshot -i` again after each meaningful DOM change.
- If the target URL is ambiguous because multiple forwarded ports exist, stop and report the ambiguity instead of guessing.
- If `agent-browser` is unavailable, fall back to bash-only verification and say so clearly.
