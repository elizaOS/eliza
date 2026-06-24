# #9298 Walkthrough Capture Smoke

Recorded with:

```bash
E2E_RECORD=1 bun run --cwd packages/app test:e2e test/ui-smoke/walkthrough/walkthrough-capture-smoke.spec.ts
```

Result: 1 passed.

Artifacts:

- `walkthrough-01-onboarding.png` - first-run onboarding with runtime choices.
- `walkthrough-02-chat-ready.png` - ready chat overlay.
- `walkthrough-03-chat-round-trip.png` - chat send/receive transcript.
- `walkthrough-04-chat-full-detent.png` - full/maximized chat detent.
- `walkthrough-05-springboard.png` - Springboard view grid.
- `walkthrough-06-launched-view.png` - launched view after Springboard tile click.
- `walkthrough-capture-smoke.webm` - recorded browser walkthrough for the same smoke path.

Scope note: this is an early keyless capture path for #9298, not the full
22-step walkthrough. The full copy/delete/paste journey remains blocked on the
surface decision documented in `packages/app/test/ui-smoke/walkthrough/JOURNEY.md`.
