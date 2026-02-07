# Autonomous (Local) Example

This folder contains **three** minimal, sandboxed “always-on” autonomous loop examples (TypeScript, Python, Rust) that all follow the same pattern:

1. **Think** using `plugin-local-ai` (local GGUF inference)
2. **Optionally act** using `plugin-shell` (restricted directory)
3. **Record** observations using `plugin-inmemorydb` (ephemeral, in-process)
4. Repeat until stopped

## Safety / guardrails

These demos are intentionally **sandboxed**:

- **Shell is directory-restricted**: set `SHELL_ALLOWED_DIRECTORY` to a dedicated sandbox folder.
- **Default command allowlist**: the examples only allow a small set of basic commands (you can expand it).
- **Kill switch**: create a `STOP` file inside the sandbox directory to stop the loop.

## Model setup (Qwen3-4B GGUF)

Download a small GGUF model file (e.g. Qwen3-4B quantized) and place it in your models directory.

- Model repo (choose a GGUF file you want): [`Qwen/Qwen3-4B-GGUF`](https://huggingface.co/Qwen/Qwen3-4B-GGUF)

Then set:

```bash
export MODELS_DIR="$HOME/.eliza/models"
export LOCAL_SMALL_MODEL="YOUR_MODEL_FILE.gguf"
```

Notes:

- The TypeScript `plugin-local-ai` implementation can auto-download its **default** models, but to use **a custom model** (like Qwen3) you should **pre-download** it and set `LOCAL_SMALL_MODEL` to the exact filename.
- Python and Rust examples expect the GGUF file to already exist (no auto-download).

## Shell sandbox setup

Pick a safe directory (example below uses this repo’s `examples/autonomous/sandbox`):

```bash
export SHELL_ALLOWED_DIRECTORY="$(pwd)/examples/autonomous/sandbox"
export SHELL_TIMEOUT=30000

# Recommended extra restrictions (network/process control, etc.)
export SHELL_FORBIDDEN_COMMANDS="curl,wget,ssh,scp,rsync,nc,socat,python,node,bun,kill,pkill,killall,shutdown,reboot"
```

Create the sandbox directory if it doesn’t exist:

```bash
mkdir -p "$SHELL_ALLOWED_DIRECTORY"
```

## Run

### TypeScript

```bash
cd examples/autonomous/typescript
bun install
bun run start
```

### Python

```bash
cd examples/autonomous/python
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python autonomous.py
```

### Rust

> **Note**: The Rust example requires `elizaos-plugin-local-ai` with the `llm` feature enabled for actual inference. This feature depends on a vendored `llama_cpp_rs` crate that is not yet included in the repository. The example will compile but exit early with an error message until the vendor is added. See the plugin's `Cargo.toml` for details.

```bash
cd examples/autonomous/rust/autonomous
cargo run --release
```

