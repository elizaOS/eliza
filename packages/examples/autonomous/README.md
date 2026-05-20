# Autonomous (Local) Example

This folder contains a minimal, sandboxed TypeScript “always-on” autonomous loop example:

1. **Think** using `plugin-local-ai` (local GGUF inference)
2. **Optionally act** using `plugin-shell` (restricted directory)
3. **Record** observations using `plugin-inmemorydb` (ephemeral, in-process)
4. Repeat until stopped

## Safety / guardrails

These demos are intentionally **sandboxed**:

- **Shell is directory-restricted**: set `SHELL_ALLOWED_DIRECTORY` to a dedicated sandbox folder.
- **Default command allowlist**: the examples only allow a small set of basic commands (you can expand it).
- **Kill switch**: create a `STOP` file inside the sandbox directory to stop the loop.

## Model Setup (Eliza-1 GGUF)

Download the Eliza-1 mobile GGUF and place it in your models directory.

- Model repo: [`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1)
- GGUF file: `bundles/2b/text/eliza-1-2b-32k.gguf`

Then set:

```bash
export MODELS_DIR="$HOME/.eliza/models"
export LOCAL_SMALL_MODEL="eliza-1-2b-32k.gguf"
```

Note: the TypeScript `plugin-local-ai` implementation can auto-download its
**default** models. For this example, pre-download the Eliza-1 mobile GGUF and
set `LOCAL_SMALL_MODEL` to the exact filename.

## Shell sandbox setup

Pick a safe directory (example below uses this repo’s `packages/examples/autonomous/sandbox`):

```bash
export SHELL_ALLOWED_DIRECTORY="$(pwd)/packages/examples/autonomous/sandbox"
export SHELL_TIMEOUT=30000

# Recommended extra restrictions (network/process control, etc.)
export SHELL_FORBIDDEN_COMMANDS="curl,wget,ssh,scp,rsync,nc,socat,python,node,bun,kill,pkill,killall,shutdown,reboot"
```

Create the sandbox directory if it doesn’t exist:

```bash
mkdir -p "$SHELL_ALLOWED_DIRECTORY"
```

## Run

```bash
cd packages/examples/autonomous
bun install
bun run start
```

## Validate

```bash
bun run test
bun run typecheck
```

The test suite covers the local decision parser, shell-command allowlist, and
prompt construction without starting local inference or shell services.
