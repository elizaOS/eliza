# @elizaos/plugin-personal-assistant

Owner operations and cross-domain personal-assistant orchestration for Eliza agents.

Composes owner operations across domain plugins. Use the shared scheduling runner,
entity/relationship stores, and attachment store. Load the database adapter and required
domain/connector plugins first. Household documents remain owner-private unless an
explicit current grant authorizes access.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-personal-assistant build  # build
bun run --cwd plugins/plugin-personal-assistant test   # tests
```
