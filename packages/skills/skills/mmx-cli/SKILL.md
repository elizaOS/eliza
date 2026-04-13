---
name: mmx-cli
description: Use mmx to generate text, images, video, speech, and music via the MiniMax AI platform. Use when the user wants to create media content, chat with MiniMax models, perform web search, or manage MiniMax API resources from the terminal.
homepage: https://github.com/MiniMax-AI/cli
metadata:
  {
    "otto":
      {
        "emoji": "🤖",
        "requires": { "bins": ["mmx"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "mmx-cli",
              "bins": ["mmx"],
              "label": "Install mmx-cli (npm)",
            },
          ],
      },
  }
---

# mmx-cli (mmx)

Use `mmx` to generate text, images, video, speech, and music via the MiniMax AI platform.

## Auth

```bash
mmx auth login --api-key sk-xxxxx   # persist to ~/.mmx/credentials.json
mmx auth status                      # verify active auth source
```

## Agent Flags

Always use in non-interactive contexts:

- `--non-interactive` — fail fast on missing args
- `--quiet` — suppress spinners; stdout is pure data
- `--output json` — machine-readable output
- `--async` — return task ID immediately (video generation)
- `--yes` — skip confirmation prompts

## Commands

```bash
# Text generation (MiniMax-M2.7)
mmx text chat --message "user:Hello" --output json --quiet

# Image generation (image-01)
mmx image generate --prompt "A cat in a spacesuit" --quiet

# Video generation (async, MiniMax-Hailuo-2.3)
mmx video generate --prompt "Ocean waves." --async --quiet

# Speech synthesis (speech-2.8-hd, 300+ voices)
mmx speech synthesize --text "Hello world" --out hello.mp3 --quiet

# Music generation (music-2.6)
mmx music generate --prompt "Upbeat pop about summer" --lyrics-optimizer --out song.mp3 --quiet

# Web search
mmx search query --q "MiniMax AI" --output json --quiet
```

## Piping

```bash
# stdout is always clean data — safe to pipe
mmx text chat --message "Hi" --output json | jq '.content'

# Chain: generate image → describe it
URL=$(mmx image generate --prompt "A sunset" --quiet)
mmx vision describe --image "$URL" --quiet
```

## Config

```bash
mmx config set --key region --value cn   # cn or global
mmx config show
```
