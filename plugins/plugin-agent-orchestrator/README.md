# @elizaos/plugin-agent-orchestrator

Canonical elizaOS plugin for spawning and orchestrating coding sub-agents via the Agent
Client Protocol (ACP), with workspace lifecycle, GitHub integration, task history, and
runtime-driven sub-agent routing.

The default ACP transport is native; `ELIZA_ACP_TRANSPORT=cli` selects the acpx wrapper.
Configure the chosen coding-agent executable and credentials. Child session identities
and credential environments are spawn-managed; do not reuse one child’s authority for
another.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-agent-orchestrator build  # build
bun run --cwd plugins/plugin-agent-orchestrator test   # tests
```
