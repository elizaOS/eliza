# Relates to

<!-- Link the issue or explain the problem. -->

# Change

<!-- Describe the resulting behavior and any material risks. -->

# Testing

<!-- List commands and results. Include reproduction or review steps when needed. -->

- [ ] Targets `develop` and has no conflicts with the latest `origin/develop`.
- [ ] Ran `bun install` and `bun run verify` after syncing; record blockers below.
- [ ] Updated relevant documentation.

# Evidence Gate

Evidence must match the reviewed commit. `packages/scripts/pr-evidence.ts rows`
sets the marker from the live PR head; rerun after each push.
<!-- evidence-head:replace-with-current-40-character-head-sha -->

Keep every row. Attach artifacts inline or write `N/A - <reason>` where
inapplicable. UI changes require desktop/mobile before-and-after screenshots,
a walkthrough, logs, and OCR review. Use MP4 videos and preferably JPG images.
Keep generated artifacts out of source control.

<!-- evidence-row:before-screenshots -->
- [ ] Before full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:after-screenshots -->
- [ ] After full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:walkthrough-video -->
- [ ] A video walkthrough of the complete user flow is attached, or marked
      `N/A - <reason>`.
<!-- evidence-row:backend-logs -->
- [ ] Backend logs show the real code path firing end to end, or are marked
      `N/A - <reason>`.
<!-- evidence-row:frontend-logs -->
- [ ] Frontend console and network logs show the request/response and state
      change, or are marked `N/A - <reason>`.
<!-- evidence-row:llm-trajectory -->
- [ ] Real-LLM trajectory is attached for agent/action/provider/prompt/model
      changes, or marked `N/A - <reason>`.
<!-- evidence-row:domain-artifacts -->
- [ ] Domain artifacts are attached where applicable (DB rows, memories,
      scheduled tasks, wallet/on-chain output, generated files, audio, etc.), or
      marked `N/A - <reason>`.
<!-- evidence-row:ocr-review -->
- [ ] OCR visual-text review output is attached for UI changes, or marked
      `N/A - <reason>` when the change has no rendered visual surface.

# Evidence Details

<!-- Link artifacts or paste transcripts in <details> blocks or fenced code blocks.
For agent behavior changes, include a real-model trajectory. For voice changes,
include captured audio. Explain how the evidence exercises the changed behavior. -->

For app UI changes, run `bun run --cwd packages/app audit:app` and inspect the
captures. `bun run test:matrix:review` produces and reviews a verified bundle;
use the bundle path printed by the command to revisit that same run.

## Known gaps / failures

<!-- Record failed commands, missing evidence, unavailable services/devices,
and remaining validation. For unavailable CI, include the checked commit,
run URLs, local results, and why the failures are outside this change. -->

## Deployment

<!-- Include migration or rollout steps only when needed. -->
