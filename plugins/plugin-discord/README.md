# @elizaos/plugin-discord

Discord connector plugin for elizaOS — connects an Eliza agent to Discord servers via
the Discord.js gateway.

Enable `connectors.discord.enabled` in the host configuration and set
`DISCORD_APPLICATION_ID` and `DISCORD_API_TOKEN`. Configure required bot intents in
Discord. This is a Node host package with one public entry; it does not run in a
browser. Restrict channels and DM access explicitly for the intended deployment.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-discord build  # build
bun run --cwd plugins/plugin-discord test   # tests
```
