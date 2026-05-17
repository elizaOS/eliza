# OpenClaw Configuration Reference (Local Mirror)

> Mirrored from: `/root/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/docs/config.md`
> Last synced: 2025-01-10

## agents.defaults

Top-level agent defaults applied to all agents unless overridden per-agent.

### agents.defaults.workspace
Default: `~/.openclaw/workspace`

### agents.defaults.model
Primary model and optional fallbacks.
```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-5-mini"]
      }
    }
  }
}
```

### agents.defaults.subagents

Controls sub-agent spawning, isolation, and resource management.

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | (inherit caller) | Default model for spawned sub-agents |
| `thinking` | string | (inherit caller) | Default thinking level for sub-agents |
| `maxConcurrent` | number | 8 | Global concurrency lane cap for sub-agent runs |
| `maxSpawnDepth` | number | 1 | Maximum nesting depth (1-5) |
| `maxChildrenPerAgent` | number | 5 | Max active children per agent session (1-20) |
| `runTimeoutSeconds` | number | 0 | Default timeout for sessions_spawn (0 = no timeout) |
| `archiveAfterMinutes` | number | 60 | Auto-archive after N minutes |

Example:
```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "openai/gpt-5-mini",
        maxConcurrent: 4,
        maxSpawnDepth: 2,
        maxChildrenPerAgent: 5,
        runTimeoutSeconds: 900,
        archiveAfterMinutes: 60
      }
    }
  }
}
```

**Key behaviors:**
- Sub-agents run in isolated sessions (`agent:<id>:subagent:<uuid>`)
- Main agent monitoring is unaffected (use `/subagents list`, `sessions_list`)
- Results announced back to requester chat upon completion
- Each sub-agent has its own context and token budget

### agents.defaults.heartbeat

Periodic heartbeat for background checks.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        model: "openai/gpt-5-mini",
        session: "main"
      }
    }
  }
}
```

### agents.defaults.compaction

Context window compaction settings.

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: true,
        maxTokens: 120000,
        targetTokens: 40000,
        model: "openai/gpt-5-mini"
      }
    }
  }
}
```

### agents.defaults.sandbox

Execution sandbox mode.

| Mode | Description |
|---|---|
| `off` | No sandboxing |
| `prefer` | Use sandbox when available |
| `require` | Fail if sandbox unavailable |

### agents.list (per-agent overrides)

Array of agent configurations. Each agent can override defaults.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable agent identifier |
| `default` | boolean | no | Mark as default agent |
| `name` | string | no | Display name |
| `model` | string/object | no | Model override |
| `subagents.allowAgents` | string[] | no | Allowlist for sessions_spawn |

## tools.subagents

Sub-agent tool policy configuration.

```json5
{
  tools: {
    subagents: {
      tools: {
        deny: ["gateway", "cron"],
        // allow: ["read", "exec", "process"]  // allow-only mode
      }
    }
  }
}
```

## Validation

Configuration must pass JSON Schema validation on load. Invalid fields cause gateway startup failure with descriptive error messages.

Common validation errors:
- Unknown keys not in schema
- Wrong types (e.g., string where number expected)
- Missing required fields in nested objects
- Values outside allowed ranges (e.g., maxSpawnDepth > 5)
