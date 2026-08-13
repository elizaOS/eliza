# Agent Plugins for elizaOS

Eliza client for the [Agent Plugins 1.0.0](https://agent-plugins.org/specification) package format.

This plugin does **not** reimplement Agent Skills or MCP. It discovers and validates portable Agent Plugin packages (`plugin.json` + `skills/` + `mcp.json`) and bridges them into the existing first-party plugins when those services are present:

| Package | Role |
|---------|------|
| `@elizaos/plugin-agent-plugins` | Package format client (this plugin) |
| `@elizaos/plugin-agent-skills` | Agent Skills runtime (SKILL.md / ClawHub) |
| `@elizaos/plugin-mcp` | MCP client (stdio / HTTP / SSE) |

## Directory layout

An Agent Plugin is a directory:

```
my-plugin/
├── plugin.json
├── skills/
│   └── summarize/
│       ├── SKILL.md
│       ├── scripts/
│       └── references/
├── mcp.json
└── com.example.client/   # ignored unless the namespace is implemented
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `AGENT_PLUGINS_DIR` | `./agent-plugins` | Directory of installed packages (each subdirectory is a plugin root) |
| `AGENT_PLUGIN_PATHS` | — | Comma-separated extra plugin roots to load without copying |
| `AGENT_PLUGINS_ENABLE_MCP` | `false` | If true, attempt to connect valid `mcp.json` servers via `@elizaos/plugin-mcp` |

Auto-enable: set `config.features.agentPlugins` to a truthy value.

## Example package

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "summarize-kit",
  "version": "1.0.0",
  "description": "Summarization skill plus a local MCP helper"
}
```

Point `AGENT_PLUGIN_PATHS` at the package root, or install it into `AGENT_PLUGINS_DIR` with the `AGENT_PLUGIN` action (`action=install`, local directory only).

To expose packaged skills through `@elizaos/plugin-agent-skills` without this plugin's runtime bridge, set `BUNDLED_SKILLS_DIRS` / `PLUGIN_SKILLS_DIRS` to `<plugin>/skills`.

## Security

- **No marketplace / no remote fetch in v1.** Install is local filesystem only. A URL fails closed.
- **No auto MCP.** Discovered servers are listed in the `agent_plugins` provider. Processes start only when `AGENT_PLUGINS_ENABLE_MCP` is true **and** `McpService` exposes a public connect API.
- **Path containment.** `plugin.json`, `skills/*/SKILL.md`, and plugin-relative MCP `command` / `cwd` values must resolve inside the plugin root. Escaping `../` paths and escaping symlinks are rejected at the narrowest failure boundary (one server or one skill, not the whole package unless the manifest itself is invalid).
- **Unknown client extensions** (`extensions` namespaces and `com.example.client/` directories) are ignored.

## Actions

`AGENT_PLUGIN` with ops `list`, `details`, `install`, `uninstall`, `reload`.

Similes: `AGENT_PLUGINS`, `LOAD_AGENT_PLUGIN`, `INSTALL_AGENT_PLUGIN`.
