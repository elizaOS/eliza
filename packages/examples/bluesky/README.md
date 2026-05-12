# Bluesky Agent Example

A full-featured AI agent running on Bluesky, implemented in TypeScript, Python, and Rust. This agent uses the **complete elizaOS runtime pipeline** - no shortcuts, no bypasses.

## Key Features

- **Full elizaOS Pipeline**: Processes messages through `messageService.handleMessage()` with:
  - State composition using providers (CHARACTER, RECENT_MESSAGES, ACTIONS, etc.)
  - `shouldRespond` evaluation (LLM-powered decision making)
  - Action planning and execution
  - Response generation via `messageHandlerTemplate`
  - Post-message hooks via `runtime.runActionsByMode("ALWAYS_AFTER", ...)`
  - Memory persistence
- **basicCapabilities Enabled**: Default actions (REPLY, IGNORE, NONE) work out of the box
- **Mention Handling**: Automatically responds to @mentions
- **Direct Messages**: Processes and replies to DMs
- **Automated Posting**: Optionally posts on a schedule
- **SQL-backed Memory**: Persistent storage with PostgreSQL or PGLite
- **Multi-language**: TypeScript, Python, and Rust implementations

## How It Works

This agent uses the canonical elizaOS message processing:

```
Bluesky Notification → Create Memory → messageService.handleMessage()
                                              ↓
                                    ┌─────────────────────┐
                                    │ State Composition   │ (providers)
                                    └─────────────────────┘
                                              ↓
                                    ┌─────────────────────┐
                                    │ shouldRespond       │ (LLM evaluation)
                                    └─────────────────────┘
                                              ↓
                                    ┌─────────────────────┐
                                    │ Action Planning     │ (if enabled)
                                    └─────────────────────┘
                                              ↓
                                    ┌─────────────────────┐
                                    │ Response Generation │ (messageHandlerTemplate)
                                    └─────────────────────┘
                                              ↓
                                    ┌─────────────────────┐
                                    │ Callback            │ (posts to Bluesky)
                                    └─────────────────────┘
                                              ↓
                                    ┌─────────────────────┐
                                    │ ALWAYS_AFTER hooks  │ (run post-response)
                                    └─────────────────────┘
```

## Quick Start

### 1. Configure Environment

```bash
cp env.example .env
# Edit .env with your credentials
```

Required settings:
- `BLUESKY_HANDLE`: Your Bluesky handle (e.g., `yourname.bsky.social`)
- `BLUESKY_PASSWORD`: App password from https://bsky.app/settings/app-passwords
- `OPENAI_API_KEY`: OpenAI API key (or use another model provider)

### 2. Build Dependencies

```bash
# From the repo root, build the required plugins
bun install
bun run build
```

### 3. Run the Agent

#### TypeScript

```bash
cd examples/bluesky
bun install
bun run start
```

#### Python

```bash
cd examples/bluesky/python
pip install -r requirements.txt
python agent.py
```

#### Rust

```bash
cd examples/bluesky/rust/bluesky-agent
cargo run --release
```

## Architecture

```
examples/bluesky/
├── env.example           # Environment template
├── README.md             # This file
├── typescript/           # TypeScript implementation
│   ├── agent.ts          # Main entry point (initializes runtime)
│   ├── handlers.ts       # Event handlers (uses messageService.handleMessage)
│   ├── character.ts      # Agent personality
│   ├── package.json
│   └── __tests__/        # Tests
├── python/               # Python implementation
│   ├── agent.py          # Main entry point
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

## The elizaOS Way

### Message Processing (Canonical Pattern)

```typescript
// 1. Create memory using the standard helper
const message = createMessageMemory({
  id: stringToUuid(uuidv4()),
  entityId,
  roomId,
  content: {
    text: mentionText,
    source: "bluesky",
    mentionContext: {
      isMention: true,
      mentionType: "platform_mention",
    },
  },
});

// 2. Define callback to handle the generated response
const callback: HandlerCallback = async (content: Content) => {
  // Post response to Bluesky
  const post = await postService.createPost(content.text, {
    uri: notification.uri,
    cid: notification.cid,
  });
  
  // Return memories for persistence
  return [responseMemory];
};

// 3. Process through the FULL elizaOS pipeline
await runtime.messageService.handleMessage(runtime, message, callback);
```

### What You Get

The `messageService.handleMessage()` call automatically:

1. **Saves the incoming message** to memory
2. **Composes state** with all registered providers:
   - `CHARACTER` - Agent's personality and bio
   - `RECENT_MESSAGES` - Conversation context
   - `ACTIONS` - Available actions the agent can take
   - `ANXIETY` - Conversation urgency metrics
   - `ENTITIES` - Known entities in the conversation
3. **Evaluates `shouldRespond`** using LLM when needed:
   - Direct mentions → Always respond
   - Group chats → LLM decides based on context
   - Muted rooms → Skips unless explicitly mentioned
4. **Plans actions** (if `actionPlanning` is enabled)
5. **Generates response** using `messageHandlerTemplate`:
   - Includes thought process
   - Selects actions to execute
   - Generates appropriate text
6. **Calls your callback** with the generated content
7. **Runs ALWAYS_AFTER hook actions** post-response

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

### Runtime Options

```typescript
const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin, blueSkyPlugin],
  // These are the defaults:
  // disableBasicCapabilities: false,  // REPLY, IGNORE, NONE actions
  // enableExtendedCapabilities: false, // Facts, roles, etc.
  // actionPlanning: undefined,         // Uses ACTION_PLANNING setting
  // checkShouldRespond: undefined,     // Uses CHECK_SHOULD_RESPOND setting
});
```

## Testing

### TypeScript

```bash
cd typescript
bun test                              # Unit tests (mocked)
LIVE_TEST=true bun test               # Live integration tests
```

### Python

```bash
cd python
pytest                                # Unit tests (mocked)
LIVE_TEST=true pytest                 # Live integration tests
```

### Rust

```bash
cd rust/bluesky-agent
cargo test                            # Unit tests (mocked)
cargo test --features live            # Live integration tests
```

## Customizing the Agent

### Character Personality

Edit the character configuration:

```typescript
export const character: Character = {
  name: "BlueSkyBot",
  bio: "A helpful AI assistant on Bluesky",
  system: "You are a friendly assistant...",
  
  // Topics the agent knows about
  topics: ["AI", "technology", "helpful tips"],
  
  // Personality traits
  adjectives: ["friendly", "helpful", "concise"],
  
  // Few-shot examples for the LLM
  messageExamples: [
    [
      { name: "User", content: { text: "@Bot hello!" } },
      { name: "BlueSkyBot", content: { text: "Hey there! 👋 How can I help?" } }
    ],
  ],
  
  // Examples for automated posts
  postExamples: [
    "🤖 Tip of the day: Take breaks and stay hydrated!",
  ],
};
```

### Adding Custom Actions

Register custom actions through plugins:

```typescript
const myPlugin: Plugin = {
  name: "my-plugin",
  actions: [
    {
      name: "SEARCH_WEB",
      description: "Search the web for information",
      validate: async (runtime, message) => true,
      handler: async (runtime, message, state, callback) => {
        // Implementation
      },
    },
  ],
};

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin, blueSkyPlugin, myPlugin],
});
```

## Troubleshooting

### "MessageService not available"
- Ensure the runtime is properly initialized with `await runtime.initialize()`
- Check that all required plugins are loaded

### Authentication Errors
- Use an **app password**, not your main password
- Verify handle format (e.g., `name.bsky.social`)

### Rate Limiting
- Increase `BLUESKY_POLL_INTERVAL` if hitting limits
- The agent uses exponential backoff for retries

### Database Issues
- For development, PGLite works out of the box
- For production, set `POSTGRES_URL` with valid credentials

### No Response Generated
- Check logs for `shouldRespond` evaluation results
- Verify the mention context is set correctly
- Ensure at least one model provider API key is set

## License

MIT - See the main elizaOS repository for details.
