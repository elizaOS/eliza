# Farcaster Agent Example

A self-contained TypeScript reference showing how to run an elizaOS agent that
monitors and posts on [Farcaster](https://www.farcaster.xyz/).

## Overview

| Component | Description |
|-----------|-------------|
| **Text generation + embeddings** | OpenAI via `plugin-openai` |
| **Farcaster integration** | Neynar API via `plugin-farcaster` |
| **Persistence** | `plugin-sql` (PGLite or PostgreSQL) |

The agent responds to mentions in your Farcaster feed and can autonomously post casts.

## Prerequisites

1. **OpenAI API key** – Get one at [platform.openai.com](https://platform.openai.com)
2. **Farcaster account** with a Neynar signer:
   - Sign up at [neynar.com](https://neynar.com)
   - Create a signer for your Farcaster account
   - Note your FID, Signer UUID, and API key

## Quick Start

```bash
cd packages/examples/farcaster
cp env.example .env
# Edit .env with your credentials
bun install
bun run start
```

## Validation

```bash
bun run test
bun run typecheck
bun run build
```

The local tests cover required OpenAI and Neynar/Farcaster environment validation without starting the live polling service. Live runs should start with `FARCASTER_DRY_RUN=true`.

## Configuration

Copy `env.example` to `.env` and fill in the required values:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `FARCASTER_FID` | Yes | Your Farcaster ID (FID) |
| `FARCASTER_SIGNER_UUID` | Yes | Neynar signer UUID |
| `FARCASTER_NEYNAR_API_KEY` | Yes | Neynar API key |
| `FARCASTER_DRY_RUN` | No | Set to `true` to disable posting (default: `true`) |
| `FARCASTER_MODE` | No | `polling` or `webhook` (default: `polling`) |
| `FARCASTER_POLL_INTERVAL` | No | Polling interval in seconds (default: `120`) |
| `ENABLE_CAST` | No | Enable autonomous casting (default: `false`) |
| `CAST_INTERVAL_MIN` | No | Min minutes between autonomous casts (default: `90`) |
| `CAST_INTERVAL_MAX` | No | Max minutes between autonomous casts (default: `180`) |
| `MAX_CAST_LENGTH` | No | Maximum cast length (default: `320`) |
| `DATABASE_URL` | No | PostgreSQL URL (uses PGLite if not set) |

## How It Works

For each incoming mention, the examples route the event through the elizaOS "message service" for consistent state composition and response generation.

- Uses `@elizaos/plugin-farcaster` which registers:
  - **Services**: `FarcasterService` (handles polling, client lifecycle)
  - **Actions**: `SEND_CAST`, `REPLY_TO_CAST`
  - **Providers**: `farcasterProfile`, `farcasterTimeline`, `farcasterThread`
- Mentions/replies are handled by the plugin's `FarcasterService` background clients
- Incoming mentions are routed into the runtime via `runtime.messageService.handleMessage()` inside the plugin.

### Pipeline Steps

For each incoming mention:

1. **Create a `Memory`** for the Farcaster cast (stable IDs per cast/thread)
2. **Ensure connection/room** exists in elizaOS (world + room + entity)
3. Call the language runtime's **message service**
4. **Post reply** to Farcaster (unless `FARCASTER_DRY_RUN=true`)

The TypeScript example relies on the `plugin-farcaster` service for polling and posting.

## Character

The default character (`FarcasterBot`) is configured as a helpful AI agent on Farcaster. Customize `character.ts` to change:

- Name and bio
- Topics and expertise areas
- Response style and personality
- Message examples

## Features

- **Full elizaOS Pipeline**: Uses `message_service.handle_message()` for proper state composition and response generation
- **Reply to mentions**: Automatically respond to users who mention your agent
- **Memory Persistence**: All conversations stored in SQL for continuity and deduplication
- **Thread awareness**: Understand conversation context when replying
- **Dry run mode**: Test without actually posting to Farcaster (default: enabled)
- **Rate limiting**: Built-in handling for API rate limits with backoff

## Plugin Components

The `@elizaos/plugin-farcaster` plugin provides these components:

### Actions
| Action | Description | Trigger Keywords |
|--------|-------------|-----------------|
| `SEND_CAST` | Post a new cast to Farcaster | "post", "cast", "share", "announce" |
| `REPLY_TO_CAST` | Reply to an existing cast | "reply", "respond", "answer", "comment" |

### Providers
| Provider | Description |
|----------|-------------|
| `farcasterProfile` | Agent's Farcaster profile (username, FID, bio) |
| `farcasterTimeline` | Recent casts from agent's timeline |
| `farcasterThread` | Thread context for ongoing conversations |

### Services
| Service | Description |
|---------|-------------|
| `FarcasterService` | Main service managing client lifecycle, polling, and cast operations |

## Project Structure

```
packages/examples/farcaster/
├── README.md           # This file
├── env.example         # Environment variable template
├── .gitignore          # Git ignore rules
├── agent.ts            # Main entry point
├── character.ts        # Character configuration
├── package.json        # Dependencies
└── tsconfig.json       # TypeScript config
```

## Troubleshooting

### "Missing FARCASTER_SIGNER_UUID"
Create a signer at [neynar.com](https://neynar.com) and add the UUID to your `.env` file.

### "Rate limited"
The agent handles 429 errors automatically with exponential backoff. You can also increase `FARCASTER_POLL_INTERVAL`.

### "Cast too long"
Casts are automatically truncated to `MAX_CAST_LENGTH` (default 320 characters).

## See Also

- [Farcaster Plugin Documentation](../../../plugins/plugin-farcaster/README.md)
- [elizaOS Docs](../../docs/)
- [Neynar API Documentation](https://docs.neynar.com/)
