# @elizaos/plugin-agent-orchestrator

Canonical elizaOS plugin for spawning and orchestrating coding sub-agents via the Agent
Client Protocol (ACP), with workspace lifecycle, GitHub integration, task history, and
runtime-driven sub-agent routing.

## Configure a coding agent

The plugin starts coding-agent processes on the host running Eliza. Install the
chosen ACP executable there. For adapters that use a local CLI login,
authenticate the operating-system account that runs Eliza. Installing this
package does not install or authenticate Claude Code, Codex, or another agent
for you.

The native ACP transport is the default. Set `ELIZA_ACP_DEFAULT_AGENT` to
`elizaos`, `pi-agent`, `claude`, `codex`, `kimi`, or `grok` to choose the
default adapter when a task does not name one. For example:

```sh
ELIZA_ACP_TRANSPORT=native
ELIZA_ACP_DEFAULT_AGENT=codex
```

Each adapter has a default executable command in the package manifest. If it
is not on the host's `PATH`, set that adapter's `ELIZA_*_ACP_COMMAND` to an
installed command. `ELIZA_ACP_TRANSPORT=cli` selects the legacy `acpx` wrapper
and requires `acpx` on `PATH` or an `ELIZA_ACP_CLI` command. Child session
identities and credential environments are spawn-managed; do not copy one
child's credentials into another child's environment.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-agent-orchestrator build  # build
bun run --cwd plugins/plugin-agent-orchestrator test   # tests
```
