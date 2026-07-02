# Issue #11267 - CLI inference rotation env isolation

Date: 2026-07-02
Branch: `fix/11267-cli-inference-env-isolation`
Base: `origin/develop` at `c669646b951`

## What Changed

- Removed permanent parent-process env mutation from chat-brain account rotation.
- Rotation now builds a complete SDK subprocess env from the selected pooled account's
  `envPatch`, strips competing ambient auth vars, stores that env on the warm-session
  cache key, evicts the stale warm session, and retries without writing to
  `process.env`.
- Claude SDK receives the scoped env through `query({ options: { env } })`.
- Codex SDK receives the scoped env through `new Codex({ env })`.
- Package docs now describe subprocess-scoped env injection instead of parent
  `process.env` mutation.

## Verification

Commands run from `/private/tmp/eliza-11267-cli-env` after rebasing onto current
`origin/develop`:

```bash
bun run --cwd plugins/plugin-cli-inference test
```

Result: pass. `6 passed (6)`, `87 passed (87)`.

```bash
bun run --cwd plugins/plugin-cli-inference typecheck
```

Result: pass.

```bash
bun run --cwd plugins/plugin-cli-inference lint:check
```

Result: pass. `Checked 19 files`.

```bash
bun run --cwd plugins/plugin-cli-inference build
```

Result: pass. Node build, browser build, and declarations completed.

```bash
rg -n "process\\.env\\[[^\\]]+\\]\\s*=|process\\.env\\.[A-Z0-9_]+\\s*=|applyEnvPatch" \
  plugins/plugin-cli-inference/src plugins/plugin-cli-inference/index.ts
```

Result: no matches in production source.

```bash
cmp -s plugins/plugin-cli-inference/CLAUDE.md plugins/plugin-cli-inference/AGENTS.md
```

Result: pass; package-local docs remain identical.

## Repo-Level Verify

```bash
bun run verify
```

Result: failed before typecheck/lint at `audit:type-safety-ratchet` on current
`origin/develop`, unrelated to this plugin change:

- `as unknown as`: `80 current > 77 baseline`
- ``?? {}``: `379 current > 377 baseline`

The changed `plugin-cli-inference` production source adds neither pattern.

## Evidence Applicability

- Live LLM trajectory: N/A for this patch. The changed behavior is credential
  scoping for the SDK subprocess env; unit tests exercise the rotation bridge and
  SDK integration seams without requiring a second live Claude/Codex subscription
  account.
- Screenshots/video/audio: N/A; no UI, native, audio, or visual surface changed.
