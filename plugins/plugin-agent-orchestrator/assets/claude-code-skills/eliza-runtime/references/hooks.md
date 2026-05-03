# The telemetry hooks Eliza wires into your `~/.claude/settings.json`

When the orchestrator spawns you, it patches `<workdir>/.claude/settings.json` to install HTTP hooks that fire on Claude Code lifecycle events. The hook URL is:

```
http://localhost:${ELIZA_HOOK_PORT:-2138}/api/coding-agents/hooks
```

The endpoint accepts POSTs with `{event, sessionId, data}` shape. The orchestrator's PTY service is the consumer.

## Events you emit (one-way)

These fire automatically from Claude Code's hook system — you don't need to call anything explicitly:

| Event | When it fires | What the orchestrator does |
|---|---|---|
| `PreToolUse` | Before each tool call | Records to swarm-history; broadcasts to web UI |
| `PostToolUse` | After each tool call | Updates `lastActivityAt` on your task context |
| `UserPromptSubmit` | When a prompt enters your input | Notes the input arrived, suppresses turn-complete during cooldown |
| `Stop` | When Claude Code exits its main loop | Treated as `task_complete` if you didn't already emit one |
| `permission_approved` | When auto-approval policy allowed a tool | Recorded; checked for out-of-scope-path violations |
| `task_complete` | When you go idle (PTY adapter detects) | Triggers the assessment LLM; see `references/orchestration.md` |
| `blocked` | When Claude Code waits for user input | Routed through the assessment / auto-response logic |

## Events you can manually emit

For events Claude Code doesn't fire automatically, you can POST directly. These are the supported ones:

### `decision`

The structured form of `DECISION: ...` in stdout. Use when you want the decision recorded out-of-band:

```bash
curl --max-time 3 -X POST "http://localhost:${ELIZA_HOOK_PORT:-2138}/api/coding-agents/hooks" \
  -H "content-type: application/json" \
  -d "{
    \"event\":\"decision\",
    \"sessionId\":\"$PARALLAX_SESSION_ID\",
    \"data\":{\"text\":\"chose AES-GCM over wasm-cryptl\"}
  }"
```

Or use the `scripts/eliza-decision.sh` helper.

## Events the orchestrator does NOT support

Don't try to POST these — they'll be ignored or rejected:

- `query` (no — there's no read endpoint for parent state)
- `request_input` (no — see `references/orchestration.md` "respond" decision pattern; if you need input, end your turn with a question and let the assessor escalate)
- `mutate_parent_state` (no — sub-agents are read-only against the parent)

## Self-check

You can verify the hooks are wired by reading your own settings file:

```bash
cat .claude/settings.json | python3 -c '
import json,sys
s=json.load(sys.stdin)
hooks=s.get("hooks", {})
print(f"hook events configured: {list(hooks.keys())}")
for k,v in hooks.items():
    print(f"  {k}: {v}")
'
```

If the output shows hooks pointing at `localhost:2138/api/coding-agents/hooks`, the channel is wired.

## Failure modes

| Symptom | What's happening |
|---|---|
| Hook POST returns connection refused | Parent's API server is down or restarting. The orchestrator's primary capture is your stdout — your work isn't lost; just out-of-band events for that window are. |
| Hook POST returns 401 | The orchestrator may have rotated the per-session token. Don't loop-retry; rely on stdout. |
| Hook events never reach parent (verified via dashboard) | `ELIZA_HOOK_PORT` mismatch. Fall back to default 2138 and check `~/.claude/settings.json` for the actual configured URL. |

## What this is NOT

- Not bidirectional — the parent never POSTs back to your hook URL
- Not a memory store — events are not retained as parent-readable state for you
- Not a replacement for stdout — your stdout is the durable record of your work; hooks are complementary metadata
