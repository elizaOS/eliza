# Autonomous Self-Looping Agent (Python)

A sandboxed, self-looping autonomous agent that:
- **Thinks locally** using `llama-cpp-python` with a small GGUF model (e.g., Qwen3-4B)
- **Acts** by running commands via a sandboxed shell service
- **Remembers** via in-memory storage

The agent runs a continuous loop: **plan → act → observe → store → repeat**

## Quick Start

### 1. Download a Model

```bash
# Create models directory
mkdir -p ~/.eliza/models

# Download Qwen3-4B quantized model
wget -O ~/.eliza/models/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

### 2. Install Dependencies

```bash
cd examples/autonomous/python

# Create virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate

# Install llama-cpp-python
# For CPU-only:
pip install llama-cpp-python

# For GPU (CUDA):
CMAKE_ARGS="-DGGML_CUDA=on" pip install llama-cpp-python

# For GPU (Apple Metal):
CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python
```

### 3. Run the Agent

```bash
python autonomous_agent.py
```

Or with environment variables:

```bash
LOCAL_SMALL_MODEL=Qwen3-4B-Q4_K_M.gguf \
LOOP_INTERVAL_MS=5000 \
MAX_ITERATIONS=100 \
python autonomous_agent.py
```

## How It Works

### Autonomous Loop

1. **Read State**: Gathers recent memory records, shell history, current directory listing
2. **Think**: Calls local model with a prompt asking for the next action
3. **Validate**: Ensures proposed command is safe and within sandbox
4. **Act**: Executes command (or sleeps/stops)
5. **Observe**: Captures stdout/stderr/exitCode
6. **Store**: Writes iteration record to in-memory storage
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

- Networking: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `netcat`, `socat`
- Interpreters: `python`, `python3`, `node`, `bun`, `deno`
- Process control: `kill`, `pkill`, `killall`, `reboot`, `shutdown`, `halt`, `poweroff`
- Permission changes: `chown`, `chmod`, `chgrp`, `sudo`, `su`

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
| `LOCAL_SMALL_MODEL` | `Qwen3-4B-Q4_K_M.gguf` | Model filename for inference |
| `SANDBOX_DIR` | `../sandbox` | Directory for agent operations |
| `LOOP_INTERVAL_MS` | `3000` | Delay between iterations (ms) |
| `MAX_ITERATIONS` | `1000` | Maximum loop iterations |
| `MAX_CONSECUTIVE_FAILURES` | `5` | Failures before auto-stop |
| `MEMORY_CONTEXT_SIZE` | `10` | Recent records in context |
| `CONTEXT_SIZE` | `8192` | Model context window size |
| `GPU_LAYERS` | `0` | Number of layers to offload to GPU |
| `TEMPERATURE` | `0.7` | Model temperature |
| `MAX_TOKENS` | `512` | Max tokens per generation |
| `SHELL_TIMEOUT` | `30000` | Command timeout (ms) |

## Example Session

```
╔═══════════════════════════════════════════════════════════════════╗
║           AUTONOMOUS SELF-LOOPING AGENT (Python)                  ║
╚═══════════════════════════════════════════════════════════════════╝

Configuration:
  Sandbox:         /Users/you/eliza-ok/examples/autonomous/sandbox
  Models:          /Users/you/.eliza/models
  Model:           Qwen3-4B-Q4_K_M.gguf
  Loop interval:   3000ms
  Max iterations:  1000
  Agent ID:        a1b2c3d4-...

✓ Sandbox initialized: /Users/you/eliza-ok/examples/autonomous/sandbox
Loading model: /Users/you/.eliza/models/Qwen3-4B-Q4_K_M.gguf
Model loaded successfully
Starting autonomous loop...

============================================================
=== Iteration 1 ===
============================================================
Executing: ls -la
✓ Command succeeded (exit 0)
  stdout: total 8 drwxr-xr-x  3 you  staff   96 Jan 11 12:00 . ...

============================================================
=== Iteration 2 ===
============================================================
Executing: cat WELCOME.txt
✓ Command succeeded (exit 0)
  stdout: Welcome, Autonomous Agent! This is your sandbox...

============================================================
=== Iteration 3 ===
============================================================
Executing: mkdir notes
✓ Command succeeded (exit 0)
...
```

## Troubleshooting

### Model not found
Ensure your model file exists at `~/.eliza/models/YOUR_MODEL.gguf` and `LOCAL_SMALL_MODEL` is set correctly.

### llama-cpp-python import error
Install with the correct backend:
```bash
# CPU
pip install llama-cpp-python

# CUDA
CMAKE_ARGS="-DGGML_CUDA=on" pip install llama-cpp-python --force-reinstall

# Metal (macOS)
CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python --force-reinstall
```

### Out of memory
Try a more quantized model (Q4 instead of Q8) or reduce `MEMORY_CONTEXT_SIZE`.

### Agent stuck in loop
Create a `STOP` file in the sandbox or press Ctrl+C.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Autonomous Agent Loop                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  AgentMemory │    │ LocalAIService│    │ ShellService │      │
│  │  (in-memory) │    │ (llama-cpp)  │    │  (sandboxed) │      │
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
