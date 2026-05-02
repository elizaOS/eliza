# elizaos-app

**Dynamic Python loader for [elizaOS App](https://github.com/elizaos/elizaos-app)** — a personal AI assistant built on [elizaOS](https://github.com/elizaos).

This package provides an `elizaos-app` command that automatically manages the Node.js-based elizaOS App runtime. Install via pip, run like any CLI tool.

## Install

```bash
pip install elizaos-app
```

Or with [pipx](https://pipx.pypa.io/) for isolated CLI install:

```bash
pipx install elizaos-app
```

## Quick Start

```bash
# Start your personal AI agent (installs runtime automatically on first run)
elizaos-app start

# Or just run it — interactive onboarding guides you through setup
elizaos-app

# Show all commands
elizaos-app --help
```

## How It Works

`elizaos-app` is a **dynamic loader** — a thin Python wrapper that:

1. Checks for Node.js >= 22.12.0 on your system
2. Ensures the `elizaos-app` npm package is installed globally
3. Forwards all CLI commands to the Node.js runtime
4. Installs the runtime automatically if not present

This means you get the full elizaOS App experience through pip/pipx, without needing to interact with npm directly.

## Python API

```python
from elizaos_app import run, ensure_runtime, get_version

# Ensure the runtime is installed and ready
ensure_runtime()

# Run an elizaos-app command programmatically
exit_code = run(["start"])

# Check the installed version
version = get_version()
print(f"elizaOS App {version}")
```

## Requirements

- **Python** >= 3.9
- **Node.js** >= 22.12.0 (the loader will tell you how to install it if missing)

## What is elizaOS App?

elizaOS App is a personal AI assistant you run on your own devices. It provides:

- Zero-config onboarding with interactive setup
- Support for multiple AI providers (Anthropic, OpenAI, Google, Ollama, etc.)
- Web dashboard at `http://localhost:2138`
- Plugin system for extensibility
- Web3 wallet integration (EVM + Solana)
- Desktop apps for macOS, Windows, and Linux

## Links

- [Documentation](https://docs.app.elizaos.ai)
- [GitHub](https://github.com/elizaos/elizaos-app)
- [elizaOS](https://github.com/elizaos)

## License

MIT
