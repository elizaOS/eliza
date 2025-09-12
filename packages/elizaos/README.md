# elizaos

Alias package for `@elizaos/cli` that provides the same `elizaos` command-line interface.

## What is this?

This package exists as a convenience alias on npm so you can install and run the ElizaOS CLI using either name:

- `@elizaos/cli` (canonical)
- `elizaos` (alias)

Both resolve to the exact same CLI and features.

## Install

Global install:

```bash
bun i -g elizaos
# or
bun i -g @elizaos/cli
```

Local (dev dependency):

```bash
bun add -d elizaos
# or
bun add -d @elizaos/cli
```

## Usage

```bash
# Show version
elizaos --version

# Create a new project/plugin/agent
elizaos create

# Start your project
elizaos start

# Manage agents
elizaos agent list
```

All CLI commands and options are identical to `@elizaos/cli`.

## How it works

This package depends on `@elizaos/cli` and provides a small shim binary that delegates execution to the CLI entrypoint. It is published together with `@elizaos/cli` so versions always match.

## License

MIT
