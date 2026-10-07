> [!IMPORTANT]
> **All [contribution rules](https://github.com/elizaOS/eliza/blob/develop/CONTRIBUTING.md) are required.**
> Stay within the approved MVP and PRD. Prove a useful improvement. Prefer removal,
> simpler code, and reuse. Do not submit unnecessary tests, defensive code,
> validation, or truncation. Maintainers will close unnecessary work and apply
> contributor penalties. Write in ASD-STE100 Simplified Technical English for a
> non-technical reader. Every UI change needs an uploaded explainer and walkthrough
> video, evidence that the changed flow works, and detailed steps to test it.

# Relates to

<!-- Link the issue, PRD section, and approved MVP plan item. For a new feature,
link the human discussion, maintainer approval, and updates to both plans. -->

# Change

<!-- Explain the problem and resulting behavior in plain language. Show the
failure before and success after, a relevant score gain with test conditions,
or another demonstrated improvement to an approved capability. -->

# Why this implementation

<!-- Explain your research, the alternatives, and why this choice is best.
Describe what you removed, simplified, combined, or reused. Explain why any new
type or code is necessary. Keep the explanation proportional to the change. -->

# Testing

<!-- Give setup, commands, expected results, and actual results from the real
end-to-end flow at this commit. Use existing tests first. Avoid new unit tests,
mock-only proof, and tests that repeat the implementation. For documentation-only
changes, report text and link checks. State failures and blockers honestly. -->

## How to test

<!-- Give the reviewer detailed steps, prerequisites, inputs, and expected
results. This section is required for every UI change. -->

- [ ] Targets `develop` and has no conflicts with the latest `origin/develop`.
- [ ] Ran `bun install` and `bun run verify` after syncing; record blockers below.
- [ ] Updated relevant documentation.

# Evidence Gate

Evidence must match the reviewed commit. `packages/scripts/pr-evidence.ts rows`
sets the marker from the live PR head; rerun after each push.
<!-- evidence-head:replace-with-current-40-character-head-sha -->

Keep every row. Attach artifacts inline or write `N/A - <reason>` where
inapplicable. UI changes require desktop/mobile before-and-after screenshots,
an uploaded MP4 explainer and walkthrough, video proof of the changed flow,
logs, and OCR review. Screenshots do not replace video. Use JPG images where possible.
Keep generated artifacts out of source control.

<!-- evidence-row:before-screenshots -->
- [ ] Before full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:after-screenshots -->
- [ ] After full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:walkthrough-video -->
- [ ] An MP4 explainer and walkthrough is uploaded to this PR and shows the
      complete user flow and changed behavior working. Use `N/A - <reason>`
      only when this PR has no UI change.
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
