# #8904 screenshot byte cap evidence

## Change

Screenshot forwarding selection (`selectScreenshotPaths`, used by both
`screenshotsToAttachments` and `deliverScreenshots`) now enforces:

- count cap: `MAX_SCREENSHOTS`
- per-file cap: `MAX_SCREENSHOT_FILE_BYTES` (10 MB — Telegram's `sendPhoto`
  rejects a larger single photo with HTTP 413, so an oversized shot is dropped
  rather than dispatched into a doomed send)
- total known byte cap: `MAX_SCREENSHOT_TOTAL_BYTES`

Paths whose size cannot be read (deleted between the router's existence check
and the stat) are skipped, not forwarded. When any screenshot is omitted over
the count/size budget, `deliverScreenshots` logs a `[screenshot-delivery]`
warning with the omitted/total counts so a silent drop is observable.

The real router already filters to existing paths before calling delivery, so
normal task-completion screenshot forwarding has file sizes available through
`statSync`.

> Reconciliation note: this supersedes the parallel PR #10401 for #8904. The
> `sendPhoto` photo-shaped dispatch proof #10401 cited already exists on
> `develop` (`plugins/plugin-telegram/src/messageManager.outbound-media.test.ts`,
> landed via #8876/#8989), so no new Telegram test is needed here.

## Validation

```text
bunx vitest run --config vitest.config.ts __tests__/unit/screenshot-delivery.test.ts
Test Files  1 passed (1)
Tests       13 passed (13)
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
