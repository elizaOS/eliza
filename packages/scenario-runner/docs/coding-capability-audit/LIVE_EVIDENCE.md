# Live capability evidence — Wave 2

Real sub-agent coding runs through the orchestrator's `AcpService` (native ACP
transport) on this machine, using the local provider logins. No secrets are
recorded (only account ids, booleans, and quota percentages).

## Codex — live spawn + real quota tracking + build ✅

Script: `plugins/plugin-agent-orchestrator/scripts/live-codex-spawn-e2e.ts`
(existing). Imports the real `~/.codex` ChatGPT login as a pooled `openai-codex`
account, probes real usage, selects it, materializes a per-account `CODEX_HOME`,
spawns a real Codex sub-agent, asks it to build a file.

```
Imported real Codex account (account_id d4319aea-…).
LIVE usage via pool: sessionPct=31% resetsAt=2026-06-22T12:53:12.000Z
[coding-account-bridge] codex → openai-codex account "Machine Codex (live)" via least-used
materialized auth.json: auth_mode=chatgpt access_token matches real=true
spawn result: session=e45cb4a7-… status=ready account=machine-codex
=== OUTCOME ===
real account selected: YES (machine-codex)
real credential injected into CODEX_HOME: YES
built LIVE_PROOF.txt: YES — codex-live-ok
events: ready, message×13, tool_running, blocked, tool_running
```

Proves end-to-end: **live codex coding + multi-account quota tracking (real
sessionPct) + account selection (least-used) + credential injection + real build.**

## Claude — live spawn + build ✅

Script: `plugins/plugin-agent-orchestrator/scripts/live-claude-spawn-e2e.ts`
(added in this initiative). Spawns a real Claude Code sub-agent via the
claude-agent-acp adapter using the local `~/.claude` login, asks it to build a
file.

```
Spawning REAL Claude sub-agent (npx claude-agent-acp)...
spawn result: session=bb8b076f-… status=ready
=== OUTCOME ===
spawn status: ready
built LIVE_CLAUDE_PROOF.txt: YES — claude-live-ok
events: ready, message×3, tool_running×2, blocked, tool_running
```

Proves **live Claude coding through the orchestrator end-to-end.**

## gpt-oss-120b (eliza cloud)

Routing/config wiring is covered deterministically; a live run needs an
eliza-cloud API key (not present in this environment) — gated `live-only`
scenario (`per-backend live matrix`, Wave 4).

## Reproduce

```bash
bun --conditions=eliza-source plugins/plugin-agent-orchestrator/scripts/live-codex-spawn-e2e.ts
bun --conditions=eliza-source plugins/plugin-agent-orchestrator/scripts/live-claude-spawn-e2e.ts
```
