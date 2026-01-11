# elizaOS MCP Agent Server - Python

Exposes an elizaOS agent as an MCP (Model Context Protocol) server using Python.

## Requirements

- Python 3.10+
- OpenAI API key

## Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Set up environment
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Start the server
python server.py
```

The server runs on stdio and implements the MCP protocol.

## Testing

```bash
python test_client.py
```

## Available Tools

- `chat` - Send a message to the agent
- `get_agent_info` - Get information about the agent
