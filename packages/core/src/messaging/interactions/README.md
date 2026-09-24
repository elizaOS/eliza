# Interactive message protocol

The connector-agnostic vocabulary for the structured controls an agent embeds in a reply — **forms**, **choice pickers** (pick one, or supply your own), **secret / OAuth requests**, **live task cards**, and **suggestion chips** — plus the engine that parses, serializes, lays out, and round-trips them across every surface (the dashboard, Telegram, Discord, …).

This directory is part of `packages/core`.

Build from the repository root:

```bash
bun run --cwd packages/core build
```

Test from the repository root:

```bash
bun run --cwd packages/core test
```
