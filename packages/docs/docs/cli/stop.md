---
sidebar_position: 4
title: Stop Command
description: Stop running ElizaOS agents and services
keywords: [stop, shutdown, terminate, agent management, process control]
---

# Stop Command

Stop running ElizaOS agents and free up system resources.

## Overview

The `stop` command allows you to gracefully shutdown running ElizaOS agents and services. This is useful for:

- Stopping agents during development
- Freeing up system resources
- Changing configurations
- Restarting with different settings

## Usage

```bash
elizaos stop [options]
```

## Options

| Option           | Description                          |
| ---------------- | ------------------------------------ |
| `--all`          | Stop all running ElizaOS processes   |
| `--agent <name>` | Stop a specific agent by name        |
| `--force`        | Force stop without graceful shutdown |
| `--quiet`        | Suppress confirmation messages       |

## Examples

### Basic Usage

```bash
# Stop all running agents
elizaos stop

# Stop with confirmation
elizaos stop --all

# Stop specific agent
elizaos stop --agent my-agent

# Force stop all agents
elizaos stop --all --force
```

### Process Management

```bash
# Check running agents before stopping
ps aux | grep elizaos

# Stop and verify
elizaos stop --all
ps aux | grep elizaos  # Should show no processes
```

### Development Workflow

```bash
# Start agent
elizaos start --character my-agent.json

# Make changes to configuration
# ...

# Stop agent
elizaos stop --agent my-agent

# Restart with new configuration
elizaos start --character my-agent.json
```

## Graceful Shutdown

By default, the stop command performs a graceful shutdown:

1. **Signal agents**: Sends shutdown signal to agents
2. **Complete tasks**: Allows current operations to complete
3. **Save state**: Persists conversation history and state
4. **Close connections**: Cleanly disconnects from services
5. **Release resources**: Frees memory and file handles

## Force Stop

Use `--force` when graceful shutdown fails:

```bash
# Force stop if agent is unresponsive
elizaos stop --force

# Force stop specific agent
elizaos stop --agent stuck-agent --force
```

**Warning**: Force stop may result in:

- Loss of unsaved conversation state
- Incomplete operations
- Connection cleanup issues

## Multiple Agents

When running multiple agents:

```bash
# List all running agents
elizaos agent list

# Stop specific agents
elizaos stop --agent agent1
elizaos stop --agent agent2

# Stop all at once
elizaos stop --all
```

## Integration with System Services

### Linux/macOS (systemd)

```bash
# Create service file
sudo nano /etc/systemd/system/elizaos.service

# Stop via systemd
sudo systemctl stop elizaos
```

### Process Managers

```bash
# PM2
pm2 stop elizaos

# Forever
forever stop elizaos

# Supervisor
supervisorctl stop elizaos
```

## Troubleshooting

### Agent Won't Stop

```bash
# Find process ID
ps aux | grep elizaos

# Manual kill if needed
kill -TERM <pid>

# Force kill as last resort
kill -9 <pid>
```

### Port Still in Use

```bash
# Find process using port
lsof -i :3000

# Kill process holding port
kill -9 $(lsof -ti:3000)
```

### Cleanup After Force Stop

```bash
# Remove lock files
rm -f ~/.elizaos/*.lock

# Clear temp files
rm -rf ~/.elizaos/tmp/*

# Reset state if needed
elizaos env reset
```

## Best Practices

1. **Always try graceful shutdown first**
2. **Wait for confirmation before force stopping**
3. **Check for running processes after stop**
4. **Clean up resources if force stop was used**
5. **Document any issues for debugging**

## Exit Codes

| Code | Description                           |
| ---- | ------------------------------------- |
| 0    | Successful shutdown                   |
| 1    | General error                         |
| 2    | No agents running                     |
| 3    | Partial shutdown (some agents failed) |
| 130  | Interrupted by user (Ctrl+C)          |

## Related Commands

- [`start`](./start.md): Start ElizaOS agents
- [`agent`](./agent.md): Manage individual agents
- [`dev`](./dev.md): Development mode with auto-restart
- [`env`](./env.md): Environment configuration

## Notes

- The stop command saves conversation state by default
- Agents can be restarted with the same state
- Use `--force` only when necessary
- Check logs if shutdown fails
