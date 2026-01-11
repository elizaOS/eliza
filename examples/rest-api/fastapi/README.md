# elizaOS REST API - FastAPI

A simple REST API server for chatting with an elizaOS agent using FastAPI.

**No API keys or external services required!** Uses:

- `plugin-eliza-classic` for pattern-matching responses (no LLM needed)

## Quick Start

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the server
python server.py
```

The server will start at http://localhost:3000

## API Endpoints

### GET /

Returns information about the agent.

```bash
curl http://localhost:3000/
```

### GET /health

Health check endpoint.

```bash
curl http://localhost:3000/health
```

### POST /chat

Send a message to the agent.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

Response:

```json
{
  "response": "How do you do. Please state your problem.",
  "character": "Eliza",
  "userId": "generated-uuid"
}
```

## Configuration

Set the `PORT` environment variable to change the default port:

```bash
PORT=8080 python server.py
```

## Interactive API Docs

FastAPI automatically generates interactive API documentation:

- Swagger UI: http://localhost:3000/docs
- ReDoc: http://localhost:3000/redoc



