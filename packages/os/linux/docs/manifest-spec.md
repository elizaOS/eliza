# Manifest specification

> Status: scaffold. Canonical Rust types: `eliza_types::Manifest`. Schema version: 1.

The manifest is the per-app `manifest.json` written at `~/.eliza/apps/<slug>/manifest.json`
when the codegen plugin produces an app. It declares the runtime, entry file, capability
grants, and version metadata.

## Example

```jsonc
{
  "schema_version": 1,
  "slug": "calendar",
  "title": "Calendar",
  "intent": "show me my calendar",
  "runtime": "webview",
  "entry": "src/index.html",
  "capabilities": [
    { "kind": "time:read" },
    { "kind": "storage:scoped" }
  ],
  "version": 1,
  "last_built_by": "claude-code-2.1.138",
  "last_built_at": "2026-05-10T08:00:00Z"
}
```

## Validation

`eliza_sandbox::validate(&manifest, app_root)` performs Phase 0 checks:

- `schema_version` is supported (≤ `MANIFEST_SCHEMA_VERSION`)
- `slug` matches `^[a-z0-9][a-z0-9-]*$`
- `entry` exists relative to `app_root`

Phase 1 adds: capability whitelist re-check (already enforced at parse time via the
typed enum), seccomp profile compilation, 3-second smoke launch in a hidden window.

## Versioning rules

- Bump `schema_version` *only* when the on-disk shape changes incompatibly.
- Bump the per-app `version` field on every successful atomic-swap rebuild.
- Old versions are retained under `<slug>/.history/v{N}/` (rolling window of 5;
  see locked decision #16).
