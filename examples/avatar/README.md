# VRM Voice Chat Demo (Browser)

This is a simple, browser-only demo that renders a VRM avatar and chats with an ElizaOS agent.

## Run

From repo root:

- `cd examples/avatar`
- `bun install`
- `bun run dev`

## Assets

- Default avatar: `public/bot.vrm`
- Idle animation: `public/animations/idle.glb`

## Modes

- **ELIZA classic (default)**: works offline (no API keys)
- **OpenAI / Anthropic / xAI / Gemini**: enter API keys in Settings to enable LLM responses

## Notes

- Conversations are persisted locally via `@elizaos/plugin-localdb`.
- API keys are stored in browser `localStorage` for this demo.
