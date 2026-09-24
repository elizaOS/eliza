# Android (and iOS) device e2e

Real-device end-to-end tests that drive the **actual app installed on an emulator/simulator**, against the **real backend** — not desktop Chromium with mocked `/api` (that is `playwright.ui-smoke.config.ts`).

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run --cwd packages/app build
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```
