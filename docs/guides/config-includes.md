---
title: "Config Includes"
sidebarTitle: "Config Includes"
description: "Compose modular agent configurations using the $include directive."
---

The `$include` directive lets you split agent configuration across multiple files and compose them together. This is useful for sharing base configs, separating environment-specific settings, and organizing large configurations.

## Basic Usage

### Single File Include

```json5
// agent.json5
{
  "$include": "./base.json5",
  "name": "My Custom Agent"
}
```

The contents of `base.json5` are loaded first, then `name` is merged on top (local keys override included keys).

### Multi-File Include

```json5
// agent.json5
{
  "$include": ["./base.json5", "./plugins.json5", "./mcp.json5"],
  "name": "My Agent"
}
```

Files are merged left-to-right. Later files override earlier ones. Local sibling keys override everything.

## Merge Rules

| Data Type | Behavior |
|-----------|----------|
| Objects | Deep-merged recursively (source keys win on conflict) |
| Arrays | Concatenated (target + source) |
| Scalars | Replaced by source value |

### Example

```json5
// base.json5
{
  "bio": ["A helpful assistant"],
  "connectors": {
    "telegram": { "botToken": "base-token", "groupPolicy": "allowlist" }
  }
}

// override.json5
{
  "$include": "./base.json5",
  "bio": ["A specialized agent"],
  "connectors": {
    "telegram": { "groupPolicy": "open" }
  }
}
```

Result:
```json5
{
  "bio": ["A helpful assistant", "A specialized agent"],  // arrays concatenated
  "connectors": {
    "telegram": {
      "botToken": "base-token",       // from base (not overridden)
      "groupPolicy": "open"           // overridden by local
    }
  }
}
```

## Path Resolution

Include paths are resolved relative to the file containing the `$include` directive:

```
configs/
├── base.json5                    # shared base config
├── agents/
│   ├── support-bot.json5         # "$include": "../base.json5"
│   └── sales-bot.json5           # "$include": "../base.json5"
└── mcp/
    └── common-servers.json5      # shared MCP server configs
```

Absolute paths are also supported.

## Safety

### Circular Include Detection

Circular includes are detected and throw a `CircularIncludeError` with the full chain:

```
Circular include detected: a.json5 -> b.json5 -> a.json5
```

### Depth Limit

Includes are limited to **10 levels deep** to prevent runaway recursion.

### Prototype Pollution Guard

Keys `__proto__`, `constructor`, and `prototype` are silently blocked during merge.

## Use Cases

### Environment-Specific Configs

```json5
// base.json5 — shared across all environments
{
  "bio": ["A helpful assistant"],
  "plugins": { "allow": ["telegram", "knowledge"] }
}

// production.json5
{
  "$include": "./base.json5",
  "connectors": {
    "telegram": { "botToken": "prod-token", "groupPolicy": "allowlist" }
  }
}

// development.json5
{
  "$include": "./base.json5",
  "connectors": {
    "telegram": { "botToken": "dev-token", "groupPolicy": "open" }
  }
}
```

### Shared MCP Servers

```json5
// mcp-servers.json5
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "bunx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
      }
    }
  }
}

// agent.json5
{
  "$include": ["./base.json5", "./mcp-servers.json5"],
  "name": "Agent with MCP"
}
```

### Plugin Config Modules

```json5
// connectors.json5
{
  "connectors": {
    "discord": { "token": "...", "guilds": { ... } },
    "telegram": { "botToken": "...", "groups": { ... } }
  }
}

// agent.json5
{
  "$include": ["./base.json5", "./connectors.json5"],
  "name": "Multi-Platform Agent"
}
```

## Related

- [Configuration](/configuration) — full config reference
- [Config Schema](/config-schema) — all config fields
