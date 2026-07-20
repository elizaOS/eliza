# Quality Formatter Residual R2

## Scope

Formatter-only cleanup for two UI tests introduced by merged PR #16648:

- `packages/ui/src/App.chat-overlay-first-run.test.tsx`
- `packages/ui/src/components/shell/notifications-boot.test.tsx`

Biome made only canonical line-wrapping and trailing-comma changes. No runtime or test semantics changed.

## Block 0 collision check

`gh pr list --state open --limit 100 --json number,title,headRefName,author,files` found no open PR touching either owned file.

PR #16691 owns the separate pre-existing formatter violation in `packages/app-core/src/desktop-test-bridge-notification-route.test.ts`; this R2 branch remains independent and does not duplicate that change.

## Validation evidence

- Focused tests: PASS, 2 files and 6 tests.
  - `bunx vitest run --config ./vitest.config.ts src/App.chat-overlay-first-run.test.tsx src/components/shell/notifications-boot.test.tsx`
- UI Biome formatter: PASS, 2,739 files checked.
  - `bun run --cwd packages/ui format:check`
- UI typecheck: PASS.
  - `bun run --cwd packages/cloud/routing build && bun run --cwd packages/ui typecheck`
- Type-safety ratchet: PASS, all tracked counts at baseline.
  - `bun run audit:type-safety-ratchet`
- Guide parity: PASS, 297 tracked `CLAUDE.md`/`AGENTS.md` pairs byte-identical.
  - `bun run check:agents-claude`
- Diff hygiene: PASS.
  - `git diff --check`
- Root formatter: correctly reached and reported only the separate app-core residual owned by open PR #16691 before Turbo exited nonzero. The owned UI package is fully green and this focused PR does not absorb #16691's file.
  - `bun run format:check`

[sol-orch]
