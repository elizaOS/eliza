DEVICE_INTENT parameter typing rationale (2026-05-10):
- `subaction`, `kind`, `target`, `priority` enums sourced from the imported `LifeOpsIntentKind` / `LifeOpsIntentPriority` / `LifeOpsIntentTargetDevice` literal unions. Inline literal arrays here keep the schema standalone for non-Eliza consumers.
- Added `priority`, `expiresInMinutes`, `actionUrl` to the wire schema — handler already reads them but they were missing from the typed param list.
- No required fields: the handler infers title/body from quoted strings in the message text and defaults target/kind/priority when not given.
