# plugin-rlm

RLM (Recursive Language Model) plugin for elizaOS.

## Overview

`plugin-rlm` integrates **Recursive Language Models (RLM)** into elizaOS as a
**model / reasoning adapter plugin**, following the same conceptual role and
boundaries as `plugins/plugin-localai`.

This plugin delegates text generation to an **optional external RLM backend**
while remaining fully self-contained within the plugin directory and requiring
**no modifications to elizaOS core**.

### Design Philosophy

- ElizaOS owns conversation state, memory, planning, tools, and autonomy
- RLM only receives messages and returns generated text
- No system prompt injection
- No global state or core overrides
- Fully async and non-blocking
- Safe stub behavior when the RLM backend is unavailable
- Plugin-scoped, optional, and swappable

---

## RLM Dependency

This plugin integrates with an **external Recursive Language Model (RLM)**
implementation inspired by MIT CSAIL research by **Alex Zhang et al.**

Reference implementation (upstream research repository):  
https://github.com/alexzhang13/rlm

**Important notes:**

- This repository **does not vendor, fork, or modify** the original RLM code.
- RLM is treated as an **optional dependency**.
- If the RLM package is not installed or importable, the plugin safely returns
  stub responses instead of failing.
- All RLM interaction is scoped to this plugin and does not affect elizaOS core.

This design keeps the Eliza runtime **decoupled from research-specific
dependencies** while allowing advanced reasoning engines to be integrated
cleanly as optional plugins.

The backend is imported as:

```python
from rlm import RLM
```

To enable real RLM execution, the `rlm` package must be installed separately.
Refer to Alex Zhang's GitHub repository for installation and usage details.

If the RLM backend is not installed or fails to initialize, the plugin
automatically falls back to a safe stub mode.

---

## Installation

```bash
cd plugins/plugin-rlm
pip install -e .
```

### Enable the RLM Backend (Optional)

The RLM backend is **not distributed via PyPI**.

To enable real RLM execution, install the RLM package directly from the
upstream research repository and follow its setup instructions:

https://github.com/alexzhang13/rlm

This plugin assumes the `rlm` module is importable at runtime:

```python
from rlm import RLM
```

If the RLM backend is not installed or fails to initialize, the plugin remains
fully loadable and automatically operates in safe stub mode.

---

## Configuration

The plugin reads configuration from environment variables with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `ELIZA_RLM_BACKEND` | `gemini` | RLM backend (e.g. gemini, openai) |
| `ELIZA_RLM_ENV` | `local` | RLM execution environment |
| `ELIZA_RLM_MAX_ITERATIONS` | `4` | Maximum recursive iterations |
| `ELIZA_RLM_MAX_DEPTH` | `1` | Maximum recursion depth |
| `ELIZA_RLM_VERBOSE` | `false` | Enable verbose logging |

Configuration is stored on the runtime during plugin initialization and used
when instantiating the RLM client.

---

## Usage

### Python Runtime

```python
from elizaos_plugin_rlm import plugin

# The elizaOS runtime loads the plugin via the standard plugin system.
# plugin.init(config, runtime) is called automatically by the runtime.
```

### Model Usage (Eliza v2)

The plugin registers text generation handlers declaratively using the
Eliza v2 model layer.

**Supported model types:**

- `ModelType.TEXT_SMALL`
- `ModelType.TEXT_LARGE`
- `ModelType.TEXT_REASONING_SMALL`
- `ModelType.TEXT_REASONING_LARGE`
- `ModelType.TEXT_COMPLETION`

**Example:**

```python
from elizaos.types.model import ModelType

response = await runtime.use_model(
    ModelType.TEXT_LARGE,
    {"prompt": "Hello, world!"}
)

# Returns: generated text string
```

To force the RLM provider explicitly:

```python
response = await runtime.use_model(
    ModelType.TEXT_LARGE,
    {"prompt": "Hello, world!"},
    provider="rlm"
)
```

### Handler Signature

```python
async def handle_text_generation(
    runtime: IAgentRuntime,
    params: Dict[str, Any],  # GenerateTextParams
) -> str:
    ...
```

### Supported Parameters (GenerateTextParams)

```python
params = {
    "prompt": "...",  # required
    "system": "...",  # optional (not injected by plugin)
    "messages": [{"role": "user", "content": "..."}],  # optional, overrides prompt
    "model": "...",  # optional
    "maxTokens": 1000,
    "temperature": 0.7,
    "topP": 0.9,
    "stopSequences": [...],
    "user": "...",
    "stream": False,
}
```

The plugin forwards generation controls to RLM for future compatibility,
even if the backend currently ignores some parameters.

---

## Architecture

```
plugins/plugin-rlm/
├─ pyproject.toml          # Package metadata and dependencies
├─ README.md               # This file
├─ elizaos_plugin_rlm/
│   ├─ __init__.py         # Exports: plugin
│   └─ plugin.py           # RLMClient + model handlers + Plugin definition
└─ tests/                  # Optional unit tests
```

### Component Boundaries (Eliza v2)

- **RLMClient**
  - Engine client layer
  - Async adapter around the optional `rlm` backend
  - Handles message normalization, execution, error handling, and stub fallback

- **Model Handlers**
  - Text generation handlers compatible with Eliza v2 model layer
  - Signature: `(runtime, params) -> str`
  - Registered declaratively via the plugin's `models` field

- **plugin_init**
  - Stores configuration on the runtime
  - Performs no imperative model registration
  - No side effects beyond plugin-scoped setup

This mirrors the role of `plugin-localai` while being implemented entirely in
Python with no TypeScript or Rust dependencies.

### Model Registration (Eliza v2)

Model handlers are registered **only** through the plugin's declarative
`models` field:

```python
plugin = Plugin(
    name="plugin-rlm",
    models={
        ModelType.TEXT_SMALL.value: handle_text_generation,
        ModelType.TEXT_LARGE.value: handle_text_generation,
        ModelType.TEXT_REASONING_SMALL.value: handle_text_generation,
        ModelType.TEXT_REASONING_LARGE.value: handle_text_generation,
        ModelType.TEXT_COMPLETION.value: handle_text_generation,
    },
)
```

The runtime automatically registers these handlers when the plugin is loaded.

**No imperative calls to `runtime.register_model(...)` are performed.**

---

## Stub Behavior

When the RLM backend is unavailable:

- Returns:
  ```
  "[RLM STUB] RLM backend not available"
  ```
- No exceptions are raised
- The plugin remains loadable and usable
- Behavior is deterministic and safe

---

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_rlm

# Linting
ruff check elizaos_plugin_rlm
```

---

## Cross-Runtime Mapping (Future Work)

This plugin is implemented only for **Python** in v1.

Future implementations may mirror the same architecture in other runtimes
without redesigning RLM logic.

### TypeScript (Conceptual)

- Python RLM invoked via IPC or native bindings
- Same model types and handler semantics
- Same stub behavior

### Rust (Conceptual)

- RLM invoked via PyO3, FFI, or IPC
- Same model registration pattern
- Same configuration and error semantics

**Only syntax, packaging, and IPC differ across runtimes.**  
Core RLM logic and behavior remain identical.

---

## License

MIT
