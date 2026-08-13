# @elizaos/plugin-agent-plugins

Implements the [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification) for elizaOS. It discovers and validates local `plugin.json` packages and bridges packaged skills and MCP server definitions to the existing first-party runtimes when available.

## Plugin surface

- `src/plugin.ts` registers `AgentPluginsService`, the `AGENT_PLUGIN` lifecycle action and promoted subactions, and the `agent_plugins` provider.
- `src/services/agent-plugins.ts` owns discovery, installation, unloading, and optional bridges to `@elizaos/plugin-agent-skills` and `@elizaos/plugin-mcp`.
- `src/spec/` validates manifests, contained paths, packaged skills, and MCP configuration.
- `src/actions/agent-plugin.ts` provides `list`, `details`, `install`, `uninstall`, and `reload` operations.
- `src/providers/agent-plugins.ts` exposes loaded package, skill, and MCP metadata to the runtime.

## Commands

```bash
bun run --cwd plugins/plugin-agent-plugins build
bun run --cwd plugins/plugin-agent-plugins typecheck
bun run --cwd plugins/plugin-agent-plugins test
bun run --cwd plugins/plugin-agent-plugins lint:check
bun run --cwd plugins/plugin-agent-plugins format:check
```

## Configuration

- `AGENT_PLUGINS_DIR` defaults to `./agent-plugins` and contains installed packages.
- `AGENT_PLUGIN_PATHS` adds comma-separated package roots without copying them.
- `AGENT_PLUGINS_ENABLE_MCP` defaults to `false`; MCP processes must never start unless explicitly enabled.
- `config.features.agentPlugins` controls auto-enable behavior.

## Conventions and security invariants

- Version 1 accepts local filesystem installs only. Do not add marketplace or remote-fetch behavior without a deliberate contract change.
- Keep manifest, skill, MCP command, and MCP working-directory paths contained within the package root. Reject escaping paths and symlinks at the narrowest validation boundary.
- Unknown client extension namespaces and directories are ignored.
- This plugin owns the package format, not skill execution or MCP transport. Preserve the optional service bridges rather than duplicating those runtimes.
- Keep `auto-enable.ts` lightweight because the auto-enable engine loads it independently of the full plugin runtime.
- Use structured runtime logging and follow the repository error policy for new catch boundaries.

See [README.md](README.md) for the package contract and the [root CLAUDE.md](../../CLAUDE.md) for repository-wide rules and verification requirements.
