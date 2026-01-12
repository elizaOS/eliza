# Bluesky Agent Example

A full-featured AI agent running on Bluesky, implemented in TypeScript, Python, and Rust. The agent monitors mentions and DMs, generates intelligent responses, and can post autonomously.

## Features

- **Mention Handling**: Automatically responds to @mentions
- **Direct Messages**: Processes and replies to DMs
- **Automated Posting**: Optionally posts on a schedule
- **SQL-backed Memory**: Persistent storage with PostgreSQL or PGLite
- **Multi-language**: TypeScript, Python, and Rust implementations with feature parity

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required settings:
- `BLUESKY_HANDLE`: Your Bluesky handle (e.g., `yourname.bsky.social`)
- `BLUESKY_PASSWORD`: App password from https://bsky.app/settings/app-passwords
- `OPENAI_API_KEY`: OpenAI API key (or use another model provider)

### 2. Run the Agent

#### TypeScript

```bash
cd typescript
bun install
bun run start
```

#### Python

```bash
cd python
pip install -r requirements.txt
python agent.py
```

#### Rust

```bash
cd rust/bluesky-agent
cargo run --release
```

## Architecture

```
examples/bluesky/
├── .env.example          # Environment template
├── README.md             # This file
├── typescript/           # TypeScript implementation
│   ├── agent.ts          # Main agent entry point
│   ├── handlers.ts       # Event handlers for Bluesky
│   ├── character.ts      # Agent personality
│   ├── package.json
│   └── __tests__/        # Tests
├── python/               # Python implementation
│   ├── agent.py          # Main agent entry point
│   ├── handlers.py       # Event handlers
│   ├── character.py      # Agent personality
│   ├── requirements.txt
│   └── tests/            # Tests
└── rust/                 # Rust implementation
    └── bluesky-agent/
        ├── src/
        │   ├── main.rs   # Main entry point
        │   ├── handlers.rs
        │   └── character.rs
        ├── Cargo.toml
        └── tests/        # Tests
```

## How It Works

1. **Initialization**: The agent connects to Bluesky and authenticates
2. **Polling**: Periodically fetches new notifications (mentions, follows, etc.)
3. **Event Processing**: When a mention or DM is received:
   - Creates a memory record in the database
   - Composes agent state with context
   - Generates a response using the LLM
   - Posts the reply to Bluesky
4. **Automated Posting**: If enabled, generates and posts original content on a schedule

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `BLUESKY_HANDLE` | Your Bluesky handle | Required |
| `BLUESKY_PASSWORD` | App password | Required |
| `BLUESKY_SERVICE` | Bluesky PDS URL | `https://bsky.social` |
| `BLUESKY_DRY_RUN` | Simulate without posting | `false` |
| `BLUESKY_POLL_INTERVAL` | Seconds between polls | `60` |
| `BLUESKY_ENABLE_POSTING` | Enable automated posts | `true` |
| `BLUESKY_ENABLE_DMS` | Process direct messages | `true` |
| `BLUESKY_POST_INTERVAL_MIN` | Min seconds between posts | `1800` |
| `BLUESKY_POST_INTERVAL_MAX` | Max seconds between posts | `3600` |

## Testing

### TypeScript

```bash
cd typescript
bun test                    # Unit tests (mocked)
BLUESKY_HANDLE=... bun test:live  # Live integration tests
```

### Python

```bash
cd python
pytest                      # Unit tests (mocked)
pytest --live               # Live integration tests
```

### Rust

```bash
cd rust/bluesky-agent
cargo test                  # Unit tests (mocked)
cargo test --features live  # Live integration tests
```

## Customizing the Agent

### Character Personality

Edit the character configuration in each language's `character.ts/py/rs` file:

```typescript
export const character: Character = {
  name: "BlueSkyBot",
  bio: "A helpful AI assistant on Bluesky",
  system: "You are a friendly and helpful assistant...",
  // Add more personality traits
};
```

### Adding Custom Actions

The agent can be extended with custom actions by adding them to the runtime's plugin configuration.

## Troubleshooting

### Authentication Errors
- Ensure you're using an **app password**, not your main password
- Verify your handle format (e.g., `name.bsky.social`)

### Rate Limiting
- Bluesky has rate limits; increase `BLUESKY_POLL_INTERVAL` if needed
- The agent uses exponential backoff for retries

### Database Issues
- For development, PGLite works out of the box
- For production, ensure PostgreSQL is running and `POSTGRES_URL` is set

## License

MIT - See the main elizaOS repository for details.
