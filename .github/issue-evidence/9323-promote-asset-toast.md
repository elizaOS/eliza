# 9323 Promote Asset Toast Evidence

Date: 2026-06-24

Branch: `fix/9323-promote-asset-toast`

## What Changed

`AppPromote` now surfaces failed `POST /api/v1/apps/:id/promote/assets`
requests with `toast.error`. HTTP 402 gets a specific insufficient-credits
message; other failures get a generic retry message.

## Verification

```text
$ bun install
8666 packages installed [131.14s]
```

```text
$ bun run --cwd packages/shared build:i18n
Total: 239 entries, 6 locales
Done!
```

```text
$ bun run --cwd packages/ui test app-promote.test.tsx
Test Files  1 passed (1)
Tests       2 passed (2)
```

```text
$ bunx @biomejs/biome check packages/ui/src/cloud/applications/components/app-promote.tsx packages/ui/src/cloud/applications/components/app-promote.test.tsx
Checked 2 files in 61ms. No fixes applied.
```

```text
$ bun run --cwd packages/ui typecheck
[generate-css-strings] processed 0 target(s), updated 0
```

```text
$ bun run verify
Tasks:    509 successful, 509 total
Cached:    0 cached, 509 total
Time:      3m9.909s
```

## UI Media

Full-page screenshots, video walkthrough, and browser console/network logs were
not captured for this patch. This checkout does not contain
`packages/cloud-frontend`, and `rg "AppPromote|app-promote" packages` shows the
component is only referenced by `packages/ui/src/cloud/applications/components`.
The changed behavior is a transient failed-request toast path covered by the
focused jsdom component test above.
