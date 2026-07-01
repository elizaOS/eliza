# Issue #10471 - SECRETS_INFO context gate

## Change

- Branch: `fix/10471-secrets-info-context-gate`
- Removed the raw English keyword regex from `SECRETS_INFO`.
- Provider selection now relies on the existing structured provider metadata:
  `contexts: ["secrets", "settings"]`, `contextGate`, and `roleGate`.
- Added a regression test proving selected secrets/settings context returns
  secrets info for a non-English user message.

## Validation

- `bun test packages/core/src/features/secrets/providers/secrets-status.test.ts`
  - PASS, see `focused-secrets-provider-test.log`
- `bun run --cwd packages/core typecheck`
  - PASS, see `core-typecheck.log`
- `bun run --cwd packages/core lint:check`
  - PASS, see `core-lint-check.log`
- `bun run --cwd packages/core build`
  - PASS, see `core-build.log`
- `bun install`
  - PASS after rebasing on `origin/develop`, see `install-after-rebase.log`
- `PATH="/Users/shawwalters/.bun/bin:$PATH" bun run verify`
  - PASS, see `root-verify.log`

## Additional checks

- `bun run --cwd packages/core test`
  - Attempted; blocked by unrelated existing `src/plugin.test.ts` failure that
    assigns `globalThis.Bun` where the property is readonly in this runtime.
    The failure is captured in `full-core-test.log`.
- Live model trajectory: N/A. This change is a deterministic provider-context
  gate, not model/action generation.
- Screenshots/video/audio: N/A. No UI, visual, or audio surface changed.
