# elizaOS REST API Examples

This directory contains REST API examples for elizaOS using various web frameworks across TypeScript, Python, and Rust.

**No API keys or external services required!** All examples use:
- `plugin-localdb` for local JSON-based storage (TypeScript examples)
- `plugin-eliza-classic` for pattern-matching responses (no LLM needed)

## Available Examples

| Framework | Language | Directory |
|-----------|----------|-----------|
| [Express](./express/) | TypeScript | `express/` |
| [Hono](./hono/) | TypeScript | `hono/` |
| [Elysia](./elysia/) | TypeScript | `elysia/` |
| [FastAPI](./fastapi/) | Python | `fastapi/` |
| [Flask](./flask/) | Python | `flask/` |
| [Actix Web](./actix/) | Rust | `actix/` |
| [Axum](./axum/) | Rust | `axum/` |
| [Rocket](./rocket/) | Rust | `rocket/` |

## Common API

All examples expose the same REST API:

### `GET /`
Returns information about the agent.

```bash
curl http://localhost:3000/
```

### `GET /health`
Health check endpoint.

```bash
curl http://localhost:3000/health
```

### `POST /chat`
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

## Quick Start

### TypeScript (Express, Hono, Elysia)

```bash
cd express  # or hono, elysia
bun install
bun run start
```

### Python (FastAPI, Flask)

```bash
cd fastapi  # or flask
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python server.py
```

### Rust (Actix, Axum, Rocket)

```bash
cd actix  # or axum, rocket
cargo run --release
```

## Configuration

All examples support the `PORT` environment variable:

```bash
PORT=8080 bun run start        # TypeScript
PORT=8080 python server.py     # Python
PORT=8080 cargo run --release  # Rust
```

## About ELIZA

These examples use the classic ELIZA pattern-matching algorithm from Joseph Weizenbaum's 1966 program. ELIZA simulates a Rogerian psychotherapist and responds using pattern matching and pronoun reflection - no LLM required!

Example conversation:
```
You: I am feeling sad today
Eliza: I am sorry to hear that you are feeling that way.

You: My mother doesn't understand me
Eliza: Tell me more about your family.

You: I think computers are taking over
Eliza: Do computers worry you?
```




