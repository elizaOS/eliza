# #8904 screenshot byte cap evidence

## Change

`screenshotsToAttachments` now enforces both:

- count cap: `MAX_SCREENSHOTS`
- total known byte cap: `MAX_SCREENSHOT_TOTAL_BYTES`

The real router already filters to existing paths before calling delivery, so
normal task-completion screenshot forwarding has file sizes available through
`statSync`.

## Validation

```text
bunx vitest run --config vitest.config.ts __tests__/unit/screenshot-delivery.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```

```text
bun run --cwd plugins/plugin-agent-orchestrator lint:check
Checked 241 files. No fixes applied.
```

```text
bun run --cwd plugins/plugin-agent-orchestrator typecheck
tsgo --noEmit -p tsconfig.json
```

## Remaining Evidence Gap

The live Telegram scenario from the original issue still requires a Telegram
Bot API/mock-platform scenario lane and delivered-image artifact. This PR closes
the missing total-size cap acceptance criterion; it does not claim full issue
closure.
