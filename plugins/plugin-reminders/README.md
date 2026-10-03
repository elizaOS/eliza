# @elizaos/plugin-reminders

The reminder delivery/escalation **data layer** for elizaOS agents — the `app_reminders`
schema carved out of `@elizaos/plugin-personal-assistant` (LifeOps).

Reminder records and escalation data integrate with plugin-scheduling. This package does
not own a second clock or runner. Legacy data migration must remain non-destructive.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-reminders build  # build
bun run --cwd plugins/plugin-reminders test   # tests
```
