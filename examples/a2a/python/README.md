# elizaOS A2A Agent Server - Python

An HTTP server that exposes an elizaOS agent for agent-to-agent communication using Python and FastAPI.

## Requirements

- Python 3.10+
- Optional: OpenAI API key (enables OpenAI-backed responses)

## Setup

```bash
# Create a venv and install all required packages
python -m venv venv
source venv/bin/activate
pip install -e packages/python
pip install -e plugins/plugin-openai/python
pip install -e plugins/plugin-eliza-classic/python
pip install -e plugins/plugin-inmemorydb/python
pip install -r examples/a2a/python/requirements.txt

# Optional: enable OpenAI-backed responses
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Start the server
python server.py
```

The server runs on `http://localhost:3000` by default.

## Testing

```bash
python test_runner.py
```

## API Endpoints

### `GET /`

Returns information about the agent.

### `GET /health`

Health check endpoint.

### `POST /chat`

Send a message to the agent.

**Request:**

```json
{
  "message": "Hello!",
  "sessionId": "optional-session-id"
}
```

**Response:**

```json
{
  "response": "Hello! How can I help you?",
  "agentId": "agent-uuid",
  "sessionId": "session-id",
  "timestamp": "2024-01-10T12:00:00Z"
}
```

### `POST /chat/stream`

Stream a response from the agent (Server-Sent Events).

## Configuration

- `PORT` - Server port (default: 3000)
- `OPENAI_API_KEY` - OpenAI API key (optional)
- `OPENAI_BASE_URL` - Custom OpenAI endpoint

When `OPENAI_API_KEY` is not set, the server uses `elizaos-plugin-inmemorydb` (ephemeral) + `elizaos-plugin-eliza-classic` so it can run deterministically without external services.
