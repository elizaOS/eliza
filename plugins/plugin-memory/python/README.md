# elizaOS Memory Plugin - Python

Advanced memory management plugin for elizaOS with conversation summarization and long-term persistent memory.

## Features

- **Short-term Memory (Conversation Summarization)**
  - Automatically summarizes long conversations to reduce context size
  - Retains recent messages while archiving older ones as summaries
  - Configurable thresholds for when to summarize

- **Long-term Memory (Persistent Facts)**
  - Extracts and stores persistent facts about users
  - Categorizes information using cognitive science principles:
    - **Episodic**: Specific events and experiences
    - **Semantic**: General facts and knowledge
    - **Procedural**: Skills and workflows
  - Provides context-aware user profiles across all conversations

## Installation

```bash
pip install elizaos-plugin-memory
```

## Usage

```python
from elizaos_plugin_memory import MemoryService, MemoryConfig, LongTermMemoryCategory
from uuid import uuid4

# Create configuration
config = MemoryConfig(
    short_term_summarization_threshold=16,
    long_term_extraction_enabled=True,
    long_term_confidence_threshold=0.85,
)

# Initialize service
service = MemoryService(config=config, agent_id=uuid4())

# Store a long-term memory
memory = await service.store_long_term_memory(
    agent_id=agent_id,
    entity_id=user_id,
    category=LongTermMemoryCategory.SEMANTIC,
    content="User is a senior Python developer",
    confidence=0.95,
)

# Retrieve memories
memories = await service.get_long_term_memories(user_id)
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `MEMORY_SUMMARIZATION_THRESHOLD` | 16 | Messages before summarization |
| `MEMORY_RETAIN_RECENT` | 6 | Recent messages to keep |
| `MEMORY_LONG_TERM_ENABLED` | true | Enable long-term extraction |
| `MEMORY_CONFIDENCE_THRESHOLD` | 0.85 | Minimum confidence to store |

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type check
mypy elizaos_plugin_memory

# Lint
ruff check .
```

## License

MIT

