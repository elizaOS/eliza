# Autonomous Self-Looping Agent (TypeScript)

A sandboxed, self-looping autonomous agent that:
- **Thinks locally** using `plugin-local-ai` with a small GGUF model (e.g., Qwen3-4B)
- **Acts** by running commands via `plugin-shell` (strictly inside a sandbox directory)
- **Remembers** via `plugin-inmemorydb` (ephemeral, in-process memory)

The agent runs a continuous loop: **plan → act → observe → store → repeat**

## Quick Start

### 1. Download a Model

Download a small GGUF model (e.g., Qwen3-4B quantized):

```bash
# Create models directory
mkdir -p ~/.eliza/models

# Download from Hugging Face
# Option 1: Using wget
wget -O ~/.eliza/models/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf

# Option 2: Using curl
curl -L -o ~/.eliza/models/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

### 2. Configure Environment

```bash
# Copy the example configuration
cp env.example.txt .env

# Edit .env and set your model filename
# LOCAL_SMALL_MODEL=Qwen3-4B-Q4_K_M.gguf
```

### 3. Install Dependencies

From the repository root:

```bash
bun install
```

### 4. Run the Agent

```bash
cd examples/autonomous/typescript
bun run start
```

## How It Works

### Autonomous Loop

1. **Read State**: Gathers recent memory records, shell history, current directory listing
2. **Think**: Calls local model with a prompt asking for the next action
3. **Validate**: Ensures proposed command is safe and within sandbox
4. **Act**: Executes command (or sleeps/stops)
5. **Observe**: Captures stdout/stderr/exitCode
6. **Store**: Writes iteration record to in-memory database
7. **Repeat**: Waits for loop interval, then continues

### Action Format

The agent outputs XML to decide its action:

```xml
<!-- Run a shell command -->
<action>RUN</action>
<command>ls -la</command>
<note>Listing directory contents</note>

<!-- Sleep/wait -->
<action>SLEEP</action>
<sleepMs>5000</sleepMs>
<note>Waiting for inspiration</note>

<!-- Stop the agent -->
<action>STOP</action>
<note>Task complete</note>
```

### Safety Features

- **Sandbox Boundary**: All file operations restricted to `sandbox/` directory
- **Command Filtering**: Blocks dangerous commands (networking, interpreters, process control)
- **Pattern Detection**: Blocks path traversal, command substitution
- **Timeout Protection**: Commands killed after timeout
- **Stop Mechanisms**: STOP file, max iterations, max failures, SIGINT/SIGTERM

### Blocked Commands

The following are blocked in addition to plugin-shell defaults:
- Networking: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `netcat`, `socat`
- Interpreters: `python`, `python3`, `node`, `bun`, `deno`
- Process control: `kill`, `pkill`, `killall`, `reboot`, `shutdown`, `halt`, `poweroff`
- Permission changes: `chown`, `chmod`, `chgrp`

## Stopping the Agent

Three ways to stop:

1. **STOP file**: Create a file named `STOP` in the sandbox directory
   ```bash
   touch examples/autonomous/sandbox/STOP
   ```

2. **Environment variable**: Set `AUTONOMY_ENABLED=false`

3. **Signal**: Press `Ctrl+C` (SIGINT) or send SIGTERM

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `~/.eliza/models` | Directory containing GGUF models |
| `LOCAL_SMALL_MODEL` | `DeepHermes-3-Llama-3-3B-Preview-q4.gguf` | Model filename for inference |
| `SANDBOX_DIR` | `../sandbox` | Directory for agent operations |
| `LOOP_INTERVAL_MS` | `3000` | Delay between iterations (ms) |
| `MAX_ITERATIONS` | `1000` | Maximum loop iterations |
| `MAX_CONSECUTIVE_FAILURES` | `5` | Failures before auto-stop |
| `MEMORY_CONTEXT_SIZE` | `10` | Recent records in context |
| `LOG_LEVEL` | `info` | Logging verbosity |

## Example Session

```
╔═══════════════════════════════════════════════════════════════════╗
║           AUTONOMOUS SELF-LOOPING AGENT (TypeScript)              ║
╚═══════════════════════════════════════════════════════════════════╝

[INFO] Configuration:
[INFO]   Sandbox:         /Users/you/eliza-ok/examples/autonomous/sandbox
[INFO]   Loop interval:   3000ms
[INFO]   Max iterations:  1000
[SUCCESS] Runtime initialized
[SUCCESS] Autonomous agent initialized

=== Iteration 1 ===
[INFO] Executing: ls -la
[INFO] Command succeeded (exit 0)

=== Iteration 2 ===
[INFO] Executing: cat WELCOME.txt
[INFO] Command succeeded (exit 0)

=== Iteration 3 ===
[INFO] Executing: mkdir notes
[INFO] Command succeeded (exit 0)

=== Iteration 4 ===
[INFO] Executing: echo "Started exploring at $(date)" > notes/log.txt
[INFO] Command succeeded (exit 0)
...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Autonomous Agent Loop                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  AgentMemory │    │  LocalAI     │    │  ShellService│      │
│  │  (inmemorydb)│    │  (local-ai)  │    │  (shell)     │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌──────────────────────────────────────────────────────┐      │
│  │               Autonomous Loop Controller             │      │
│  │                                                      │      │
│  │  1. Read state (memory + shell history + dir listing)│      │
│  │  2. Think (call local model)                         │      │
│  │  3. Parse XML decision                               │      │
│  │  4. Validate command safety                          │      │
│  │  5. Execute action                                   │      │
│  │  6. Store iteration record                           │      │
│  │  7. Sleep and repeat                                 │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Sandbox         │
                    │  /sandbox/       │
                    │  - WELCOME.txt   │
                    │  - notes/        │
                    │  - ...           │
                    └──────────────────┘
```

## Troubleshooting

### Model not found
Ensure your model file exists at `~/.eliza/models/YOUR_MODEL.gguf` and `LOCAL_SMALL_MODEL` is set correctly.

### Shell commands failing
Check that `SHELL_ENABLED=true` is set. The agent will auto-set `SHELL_ALLOWED_DIRECTORY` to the sandbox.

### Out of memory
Try a more quantized model (Q4 instead of Q8) or reduce `MEMORY_CONTEXT_SIZE`.

### Agent stuck in loop
Create a `STOP` file in the sandbox or press Ctrl+C.
