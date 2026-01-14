# Python Examples

Interactive examples using elizaOS Python implementation.

## Examples

| File                | Description                                         |
| ------------------- | --------------------------------------------------- |
| `chat.py`           | Interactive CLI chat with an AI agent               |
| `adventure-game.py` | Text adventure game with AI-powered decision making |

## Install

```bash
python3 -m venv examples/python/.venv --without-pip
curl -sS https://bootstrap.pypa.io/get-pip.py | ./examples/python/.venv/bin/python
./examples/python/.venv/bin/python -m pip install -e packages/python -e packages/plugin-openai/python
```

## Run

### Chat

```bash
OPENAI_API_KEY=your_key ./examples/python/.venv/bin/python examples/python/chat.py
```

### Adventure Game

```bash
# Normal mode
OPENAI_API_KEY=your_key ./examples/python/.venv/bin/python examples/python/adventure-game.py

# Suppress logs
LOG_LEVEL=fatal OPENAI_API_KEY=your_key ./examples/python/.venv/bin/python examples/python/adventure-game.py
```

## Environment Variables

| Variable             | Default                     | Description                     |
| -------------------- | --------------------------- | ------------------------------- |
| `OPENAI_API_KEY`     | (required)                  | OpenAI API key                  |
| `OPENAI_BASE_URL`    | `https://api.openai.com/v1` | API base URL                    |
| `OPENAI_SMALL_MODEL` | `gpt-5-mini`                | Small model                     |
| `OPENAI_LARGE_MODEL` | `gpt-5`                     | Large model                     |
| `LOG_LEVEL`          | `info`                      | Set to `fatal` to suppress logs |

## API Usage

### Chat Example

```python
from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# Create character and runtime
character = Character(name="Eliza", bio="A helpful AI assistant.")
runtime = AgentRuntime(character=character, plugins=[get_openai_plugin()])
await runtime.initialize()

# Handle messages
message = Memory(
    entity_id=user_id,
    room_id=room_id,
    content=Content(text="Hello!", source="cli", channel_type=ChannelType.DM.value),
)
result = await runtime.message_service.handle_message(runtime, message)
print(result.response_content.text)

# Cleanup
await runtime.stop()
```

### Adventure Game Example

```python
import uuid

from elizaos import ChannelType, Character, Content, Memory, string_to_uuid
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# Create runtime
runtime = AgentRuntime(character=character, plugins=[get_openai_plugin()])
await runtime.initialize()

# Route through the full message pipeline (planning/actions/providers/memory)
room_id = string_to_uuid("adventure-game-room")
entity_id = string_to_uuid(str(uuid.uuid4()))
message = Memory(
    entity_id=entity_id,
    room_id=room_id,
    content=Content(
        text="Choose an action...",
        source="game",
        channel_type=ChannelType.DM.value,
    ),
)
result = await runtime.message_service.handle_message(runtime, message)
chosen_action = (
    result.response_content.text
    if result.response_content and result.response_content.text
    else ""
).strip()

# Cleanup
await runtime.stop()
```
