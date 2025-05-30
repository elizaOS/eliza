---
sidebar_position: 15
title: Stop Command
description: Stop all locally running ElizaOS processes
keywords: [CLI, stop, terminate, process, pkill]
image: /img/cli.jpg
---

# Stop Command

Stop all running ElizaOS agents running locally.

## Usage

```bash
elizaos stop
```

## Options

This command does not accept any options.

## Examples

```bash
# Stop all running ElizaOS agents
elizaos stop

# Stop before switching projects
elizaos stop
cd other-project
elizaos start
```

## How It Works

The stop command uses `pkill` to find and terminate all processes matching the pattern `node.*elizaos`.

This includes agents started with:

- `elizaos start`
- `elizaos dev`
- `elizaos agent start`

## Platform Compatibility

The stop command relies on the `pkill` utility:

- **Linux/macOS**: Built-in system utility
- **Windows**: Requires WSL or alternative process management tools

## Troubleshooting

### Processes Not Stopping

```bash
# Check for running ElizaOS processes
ps aux | grep elizaos

# Manual termination if needed
pkill -9 -f elizaos
```

### Verification After Stop

```bash
# Verify all agents stopped
ps aux | grep elizaos | grep -v grep
# Should return no results
```

## Related Commands

- [`start`](./start.md): Start your project after stopping
- [`dev`](./dev.md): Run in development mode (stops existing processes automatically)
- [`agent`](./agent.md): Manage individual agents (for granular control)
