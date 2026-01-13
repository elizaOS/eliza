# ElizaOS Python Quickstart Guide

This guide explains how to run and develop with the Python version of ElizaOS.

## Prerequisites

- **Python 3.11+** (required)
- **pip** (Python package manager)

## Quick Start - Run the Chat Example

The fastest way to get started is to run the included chat example:

```bash
# From the repository root
cd /path/to/eliza

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install the core package and OpenAI plugin from source
pip install -e packages/python -e plugins/plugin-openai/python

# Set your OpenAI API key
export OPENAI_API_KEY="your-openai-api-key"

# Run the chat example
python examples/chat/python/chat.py
```

You should see:
```
🤖 Chat with Eliza (type 'quit' to exit)

You: Hello!

Eliza: Hello! How can I help you today?
```

## Installation from Repository

When working from the ElizaOS repository, install packages in editable mode:

```bash
# From the repo root, create a virtual environment
python -m venv venv
source venv/bin/activate

# Install the core package
pip install -e packages/python

# Install an LLM provider plugin (at least one required)
pip install -e plugins/plugin-openai/python      # OpenAI (recommended)
# pip install -e plugins/plugin-anthropic/python # Anthropic Claude
# pip install -e plugins/plugin-ollama/python    # Local Ollama
# pip install -e plugins/plugin-groq/python      # Groq
```

## Creating Your Own Chat Agent

Create a file called `my_agent.py`:

```python
from __future__ import annotations
import asyncio

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from uuid6 import uuid7

async def main() -> None:
    # Define your agent's character/personality
    character = Character(
        name="Eliza",
        username="eliza",
        bio="A helpful AI assistant.",
        system="You are helpful and concise.",
    )
    
    # Create the runtime with OpenAI plugin
    runtime = AgentRuntime(
        character=character,
        plugins=[get_openai_plugin()],
    )
    
    # Create unique IDs for the conversation
    user_id = uuid7()
    room_id = uuid7()

    try:
        # Initialize the runtime
        await runtime.initialize()
        print(f"\n🤖 Chat with {character.name} (type 'quit' to exit)\n")

        while True:
            try:
                user_input = await asyncio.to_thread(input, "You: ")
            except EOFError:
                break
                
            if not user_input.strip() or user_input.strip().lower() in ("quit", "exit"):
                break

            # Create a memory from the user's message
            message = Memory(
                entity_id=user_id,
                room_id=room_id,
                content=Content(
                    text=user_input,
                    source="cli",
                    channel_type=ChannelType.DM.value,
                ),
            )

            # Process the message and get a response
            result = await runtime.message_service.handle_message(runtime, message)
            print(f"\n{character.name}: {result.response_content.text}\n")

        print("\nGoodbye! 👋")
    finally:
        await runtime.stop()

if __name__ == "__main__":
    asyncio.run(main())
```

### Set Environment Variables

```bash
export OPENAI_API_KEY="your-openai-api-key"
```

### Run the Agent

```bash
python chat.py
```

## Available Python Plugins

ElizaOS provides numerous Python plugins located in `plugins/*/python/`. Install any plugin with:

```bash
pip install -e plugins/plugin-NAME/python
```

### LLM Providers
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| OpenAI | `plugins/plugin-openai/python` | GPT-4, GPT-4o, embeddings, DALL-E, Whisper |
| Anthropic | `plugins/plugin-anthropic/python` | Claude models |
| Groq | `plugins/plugin-groq/python` | Fast inference |
| Google GenAI | `plugins/plugin-google-genai/python` | Gemini models |
| Ollama | `plugins/plugin-ollama/python` | Local LLMs via Ollama |
| OpenRouter | `plugins/plugin-openrouter/python` | Multi-provider gateway |
| Local AI | `plugins/plugin-local-ai/python` | Local model inference |
| xAI | `plugins/plugin-xai/python` | Grok models |
| Vercel AI Gateway | `plugins/plugin-vercel-ai-gateway/python` | Vercel AI SDK |

### Platform Integrations
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| Telegram | `plugins/plugin-telegram/python` | Telegram bot integration |
| Discord | `plugins/plugin-discord/python` | Discord bot integration |
| Farcaster | `plugins/plugin-farcaster/python` | Farcaster social network |
| Bluesky | `plugins/plugin-bluesky/python` | Bluesky social network |

### Database & Storage
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| SQL | `plugins/plugin-sql/python` | PostgreSQL/PGLite persistence |
| LocalDB | `plugins/plugin-localdb/python` | Local file-based storage |
| InMemoryDB | `plugins/plugin-inmemorydb/python` | In-memory storage |
| S3 Storage | `plugins/plugin-s3-storage/python` | AWS S3 storage |

### Tools & Capabilities
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| Knowledge | `plugins/plugin-knowledge/python` | RAG and knowledge base |
| Memory | `plugins/plugin-memory/python` | Enhanced memory system |
| Planning | `plugins/plugin-planning/python` | Task planning capabilities |
| Goals | `plugins/plugin-goals/python` | Goal tracking |
| Todo | `plugins/plugin-todo/python` | Todo list management |
| Shell | `plugins/plugin-shell/python` | Shell command execution |
| Browser | `plugins/plugin-browser/python` | Web browsing |
| PDF | `plugins/plugin-pdf/python` | PDF processing |
| RSS | `plugins/plugin-rss/python` | RSS feed handling |
| Vision | `plugins/plugin-vision/python` | Computer vision |

### Blockchain & Web3
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| Solana | `plugins/plugin-solana/python` | Solana blockchain |
| EVM | `plugins/plugin-evm/python` | Ethereum & EVM chains |
| TEE | `plugins/plugin-tee/python` | Trusted Execution Environment |
| Polymarket | `plugins/plugin-polymarket/python` | Prediction markets |

### External Services
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| GitHub | `plugins/plugin-github/python` | GitHub integration |
| Linear | `plugins/plugin-linear/python` | Linear project management |
| N8N | `plugins/plugin-n8n/python` | N8N workflow automation |
| MCP | `plugins/plugin-mcp/python` | Model Context Protocol |
| Forms | `plugins/plugin-forms/python` | Form handling |

### Other
| Plugin | Install Path | Description |
|--------|--------------|-------------|
| Eliza Classic | `plugins/plugin-eliza-classic/python` | Classic ELIZA responses (no API needed) |
| Simple Voice | `plugins/plugin-simple-voice/python` | Voice synthesis |
| Roblox | `plugins/plugin-roblox/python` | Roblox integration |

## Example: Telegram Bot

A complete Telegram bot example is available at `examples/telegram/python/`.

```bash
# Install dependencies
pip install -e packages/python \
            -e plugins/plugin-openai/python \
            -e plugins/plugin-sql/python \
            -e plugins/plugin-telegram/python

# Set environment variables
export TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"
export OPENAI_API_KEY="your-openai-api-key"

# Run the example
python examples/telegram/python/telegram_agent.py
```

Or create your own `telegram_bot.py`:

```python
#!/usr/bin/env python3
import asyncio
import os
import signal

from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_sql import sql_plugin
from elizaos_plugin_telegram import (
    TelegramConfig,
    TelegramService,
    TelegramContent,
    TelegramMessagePayload,
)

def create_character() -> Character:
    return Character(
        name="TelegramEliza",
        username="telegram_eliza",
        bio="A helpful AI assistant on Telegram.",
        system="You are a helpful, friendly, and concise AI assistant.",
    )

async def main() -> None:
    # Validate environment
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        print("❌ TELEGRAM_BOT_TOKEN environment variable required")
        return
    
    if not os.environ.get("OPENAI_API_KEY"):
        print("❌ OPENAI_API_KEY environment variable required")
        return

    character = create_character()
    
    # Create runtime with plugins
    runtime = AgentRuntime(
        character=character,
        plugins=[
            get_openai_plugin(),
            sql_plugin,  # For persistence
        ],
    )
    
    await runtime.initialize()
    
    # Create Telegram service
    telegram_config = TelegramConfig.from_env()
    telegram_service = TelegramService(telegram_config)
    
    # Handle incoming messages
    async def handle_message(payload: TelegramMessagePayload) -> None:
        if not payload.text:
            return
            
        message = Memory(
            entity_id=uuid7(),
            room_id=uuid7(),
            content=Content(
                text=payload.text,
                source="telegram",
                channel_type=ChannelType.DM.value,
            ),
        )
        
        result = await runtime.message_service.handle_message(runtime, message)
        
        if result and result.response_content and result.response_content.text:
            response = TelegramContent(text=result.response_content.text)
            await telegram_service.send_message(payload.chat.id, response)
    
    telegram_service.on_message(lambda p: asyncio.create_task(handle_message(p)))
    
    await telegram_service.start()
    print(f"✅ {character.name} is running on Telegram!")
    
    # Wait for shutdown
    stop_event = asyncio.Event()
    
    def signal_handler():
        stop_event.set()
    
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)
    
    await stop_event.wait()
    
    await telegram_service.stop()
    await runtime.stop()
    print("👋 Goodbye!")

if __name__ == "__main__":
    asyncio.run(main())
```

### Run:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export OPENAI_API_KEY="your-openai-key"
python telegram_bot.py
```

## Example: REST API with FastAPI

A REST API example is available at `examples/rest-api/fastapi/`. This example uses the classic ELIZA pattern-matching (no API key required):

```bash
# Install dependencies
pip install -e packages/python \
            -e plugins/plugin-eliza-classic/python \
            fastapi uvicorn

# Run the server
python examples/rest-api/fastapi/server.py
```

Test with:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

Or create your own LLM-powered `server.py`:

```python
from __future__ import annotations
import asyncio
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# Configuration
PORT = int(os.environ.get("PORT", 3000))

# Pydantic models
class ChatRequest(BaseModel):
    message: str
    userId: str | None = None

class ChatResponse(BaseModel):
    response: str
    character: str
    userId: str

# FastAPI app
app = FastAPI(title="elizaOS REST API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global runtime
runtime: AgentRuntime | None = None
character: Character | None = None

@app.on_event("startup")
async def startup():
    global runtime, character
    
    character = Character(
        name="Eliza",
        bio="A helpful AI assistant.",
        system="You are helpful and concise.",
    )
    
    runtime = AgentRuntime(
        character=character,
        plugins=[get_openai_plugin()],
    )
    await runtime.initialize()
    print(f"🚀 Server running at http://localhost:{PORT}")

@app.on_event("shutdown")
async def shutdown():
    if runtime:
        await runtime.stop()

@app.get("/health")
async def health():
    return {"status": "healthy"}

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message required")
    
    user_id = request.userId or str(uuid.uuid4())
    
    message = Memory(
        entity_id=uuid7(),
        room_id=uuid7(),
        content=Content(
            text=request.message,
            source="api",
            channel_type=ChannelType.DM.value,
        ),
    )
    
    result = await runtime.message_service.handle_message(runtime, message)
    
    return ChatResponse(
        response=result.response_content.text,
        character=character.name,
        userId=user_id,
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
```

### Install Dependencies:

```bash
pip install -e packages/python -e plugins/plugin-openai/python fastapi uvicorn
```

### Run:

```bash
export OPENAI_API_KEY="your-openai-key"
python server.py
```

### Test:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

## Core Concepts

### Character

The `Character` defines your agent's personality:

```python
from elizaos import Character

character = Character(
    name="MyAgent",           # Display name
    username="myagent",       # Unique identifier
    bio="A helpful assistant.", # Short description
    system="You are helpful and concise.", # System prompt
    settings={                # Optional settings
        "CHECK_SHOULD_RESPOND": False,  # Always respond (ChatGPT mode)
    },
)
```

### AgentRuntime

The `AgentRuntime` is the core of your agent:

```python
from elizaos.runtime import AgentRuntime

runtime = AgentRuntime(
    character=character,
    plugins=[...],            # List of plugins
    conversation_length=32,   # Context window
    log_level="INFO",         # Logging level
    check_should_respond=False,  # Always respond mode
)

await runtime.initialize()
# ... use runtime ...
await runtime.stop()
```

### Memory

Messages are represented as `Memory` objects:

```python
from elizaos import Memory, Content, ChannelType
from uuid6 import uuid7

message = Memory(
    entity_id=uuid7(),        # User ID
    room_id=uuid7(),          # Conversation ID
    content=Content(
        text="Hello!",
        source="cli",
        channel_type=ChannelType.DM.value,
    ),
)
```

### Message Processing

Use the message service to process messages:

```python
result = await runtime.message_service.handle_message(runtime, message)
print(result.response_content.text)  # Agent's response
```

## Development Setup

For local development from the repository:

```bash
# Clone the repo (if you haven't already)
git clone https://github.com/elizaos/eliza.git
cd eliza

# Create virtual environment at the repo root
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install core package in editable mode
pip install -e packages/python

# Install plugins you need (examples)
pip install -e plugins/plugin-openai/python
pip install -e plugins/plugin-sql/python
pip install -e plugins/plugin-telegram/python

# Install dev dependencies
pip install -e "packages/python[dev]"
```

### Running Tests

```bash
# Run tests from repo root
cd packages/python
pytest

# With coverage
pytest --cov=elizaos

# Type checking
mypy elizaos

# Linting
ruff check elizaos
```

## Configuration

### Environment Variables

Common environment variables:

```bash
# LLM Providers
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GOOGLE_API_KEY=...

# Platform Integrations
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...

# Database
POSTGRES_URL=postgresql://user:pass@localhost:5432/eliza

# General
LOG_LEVEL=INFO
```

### Runtime Settings

Access settings from within your code:

```python
# Get a setting
api_key = runtime.get_setting("OPENAI_API_KEY")

# Set a setting
runtime.set_setting("MY_SETTING", "value")

# Get all settings
all_settings = runtime.get_all_settings()
```

## Examples Directory

The repository includes complete examples in `/examples`:

- `chat/python/` - Simple CLI chat
- `telegram/python/` - Telegram bot
- `discord/python/` - Discord bot
- `rest-api/fastapi/` - FastAPI REST server
- `rest-api/flask/` - Flask REST server
- `bluesky/python/` - Bluesky integration
- `mcp/python/` - Model Context Protocol
- `a2a/python/` - Agent-to-agent communication

Each example includes:
- `requirements.txt` - Dependencies
- `README.md` - Setup instructions
- Source code - Working implementation

## Troubleshooting

### Common Issues

**"No model handler registered"**
- Install an LLM provider plugin: `pip install -e plugins/plugin-openai/python`
- Ensure the plugin is passed to `AgentRuntime(plugins=[...])`

**"OPENAI_API_KEY not set"**
- Export the environment variable: `export OPENAI_API_KEY=sk-...`
- Or create a `.env` file in your project directory

**"Database adapter not set"**
- For persistence, add a database plugin: `pip install -e plugins/plugin-sql/python`
- Without persistence, the agent works but doesn't save conversation history

**Import errors (ModuleNotFoundError)**
- Ensure you're in the activated virtual environment: `source venv/bin/activate`
- Install the core package: `pip install -e packages/python`
- Check that you're running commands from the repository root

**"python: can't open file"**
- Make sure you're in the correct directory
- Use full paths: `python examples/chat/python/chat.py`

## Repository Structure

```
eliza/
├── packages/
│   └── python/              # Core elizaos package
│       ├── elizaos/         # Source code
│       ├── pyproject.toml   # Package configuration
│       └── tests/           # Unit tests
├── plugins/
│   ├── plugin-openai/python/    # OpenAI plugin
│   ├── plugin-telegram/python/  # Telegram plugin
│   └── ...                      # Other plugins
└── examples/
    ├── chat/python/         # CLI chat example
    ├── telegram/python/     # Telegram bot example
    ├── discord/python/      # Discord bot example
    └── rest-api/fastapi/    # REST API example
```

## License

MIT
