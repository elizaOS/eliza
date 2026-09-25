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

The managed morning brief follows authenticated owner foreground activity after the configured owner-day boundary (04:00 by default), with admission and day consumption persisted on its scheduled-task row. Manual refresh is separate; customized schedules are preserved. Android requires an authenticated user-present report with an unlocked, interactive device; iOS uses foreground events. Client reports are not OS attestation. Duplicate defaults and unresolved legacy delivery require reconciliation.
