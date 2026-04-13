## Roblox agent bridge (Rust)

This example runs an **Axum** server that Roblox can call to send chat to an agent.

### Environment variables

- `PORT` (default: `3042`)
- `ELIZA_ROBLOX_SHARED_SECRET` (recommended; must match the Luau script)
- `ROBLOX_ECHO_TO_GAME=true` (optional; publish agent replies back into Roblox via MessagingService)
- `ROBLOX_API_KEY` and `ROBLOX_UNIVERSE_ID` (required only if `ROBLOX_ECHO_TO_GAME=true`)

This example uses `elizaos-plugin-eliza-classic` for responses by default, and can optionally publish replies into Roblox via Open Cloud.

### Run

```bash
cd examples/roblox/rust
cargo run
```

