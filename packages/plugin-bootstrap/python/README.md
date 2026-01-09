# elizaOS Bootstrap Plugin (Python)

Python implementation of the elizaOS Bootstrap Plugin, providing core agent actions, providers, evaluators, and services.

## Installation

```bash
pip install elizaos-plugin-bootstrap
```

## Features

### Actions

- **REPLY** - Generate and send a response message
- **IGNORE** - Ignore the current message
- **NONE** - Take no action
- **FOLLOW_ROOM** - Follow a room for updates
- **UNFOLLOW_ROOM** - Stop following a room
- **MUTE_ROOM** - Mute notifications from a room
- **UNMUTE_ROOM** - Unmute a room
- **GENERATE_IMAGE** - Generate images using AI models
- **UPDATE_ROLE** - Update entity roles
- **UPDATE_SETTINGS** - Modify agent settings
- **SEND_MESSAGE** - Send a message to a specific target
- **UPDATE_ENTITY** - Update entity information
- **CHOOSE_OPTION** - Select from available options

### Providers

- **CHARACTER** - Agent character definition and personality
- **RECENT_MESSAGES** - Recent conversation history
- **CURRENT_TIME** - Current time and date
- **WORLD** - World context and settings
- **ENTITIES** - Information about participants
- **KNOWLEDGE** - Relevant knowledge from the knowledge base
- **FACTS** - Known facts about entities
- **ACTION_STATE** - Current action state
- **AGENT_SETTINGS** - Agent configuration

### Evaluators

- **GOAL** - Evaluate progress toward goals
- **REFLECTION** - Reflect on agent behavior

### Services

- **TaskService** - Task management and tracking
- **EmbeddingService** - Text embedding generation

## Usage

```python
from elizaos_plugin_bootstrap import bootstrap_plugin

# Register with the agent runtime
await runtime.register_plugin(bootstrap_plugin)
```

## Development

### Setup

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install with dev dependencies
pip install -e ".[dev]"
```

### Testing

```bash
# Run tests
pytest

# Run with coverage
pytest --cov=elizaos_plugin_bootstrap
```

### Type Checking

```bash
mypy elizaos_plugin_bootstrap
```

### Linting

```bash
ruff check elizaos_plugin_bootstrap
ruff format elizaos_plugin_bootstrap
```

## License

MIT License - see LICENSE file for details.

