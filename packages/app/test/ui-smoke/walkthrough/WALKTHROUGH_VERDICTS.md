# Full Walkthrough — Vision Verdicts

Per-step screenshot verdicts for the continuous full-walkthrough run, scored
against each step's expectation row in [`JOURNEY.md`](./JOURNEY.md).

> **Re-capture pending (#9952 P4).** The journey was rewritten to drive the REAL
> in-chat onboarding (#9952) — greeting → runtime CHOICE → provider → one
> `POST /api/first-run` — plus all 8 tutorial frames, replacing the old faked
> first-run flip and the dead `first-run-chat` / `first-run-runtime` / `choice-remote`
> selectors. The 26-step layout below is regenerated from the rewritten
> `journey.ts`. The vision verdicts are produced by the nightly **live** lane
> (`app-live-e2e.yml` → `walkthrough-live`, no `--skip-review`) and by
> `bun run --cwd packages/app test:e2e:walkthrough:live` locally; the keyless PR
> lane (`scenario-pr.yml` → `app-walkthrough-mock`, `--skip-review`) records the
> screenshots + stitched mp4 without vision scoring (no funded key). Fill the
> verdict per row (`good` · `needs-work` · `needs-eyeball` · `broken`) from the
> uploaded artifact bundle after the lane runs; no row ships blank.
>
> Method: the automated reviewer (`scripts/ai-qa/review-walkthrough.mjs`) scores
> each `NN-step.png` against its JOURNEY.md expectation; any `needs-work` /
> `broken` row that is a pre-existing app defect (the walkthrough drives existing
> surfaces, it does not change them) is annotated as such.

| Step | Viewport | Verdict | Notes |
| --- | --- | --- | --- |
| 01 cold-launch | desktop | ⏳ pending | re-capture on next walkthrough run |
| 02 onboarding-runtime | desktop | ⏳ pending | re-capture on next walkthrough run |
| 03 onboarding-provider | desktop | ⏳ pending | re-capture on next walkthrough run |
| 04 provisioning-ready | desktop | ⏳ pending | re-capture on next walkthrough run |
| 05 tutorial | desktop | ⏳ pending | re-capture on next walkthrough run |
| 06 help | desktop | ⏳ pending | re-capture on next walkthrough run |
| 07 settings-open | desktop | ⏳ pending | re-capture on next walkthrough run |
| 08 wallet | desktop | ⏳ pending | re-capture on next walkthrough run |
| 09 chat-round-trip | desktop | ⏳ pending | re-capture on next walkthrough run |
| 10 chat-full-detent | desktop | ⏳ pending | re-capture on next walkthrough run |
| 11 chat-navigate-character | desktop | ⏳ pending | re-capture on next walkthrough run |
| 12 character-edit | desktop | ⏳ pending | re-capture on next walkthrough run |
| 13 new-chat | desktop | ⏳ pending | re-capture on next walkthrough run |
| 14 home-from-chat | desktop | ⏳ pending | re-capture on next walkthrough run |
| 15 restore-chat | desktop | ⏳ pending | re-capture on next walkthrough run |
| 16 copy-message | desktop | ⏳ pending | re-capture on next walkthrough run |
| 17 paste-large | desktop | ⏳ pending | re-capture on next walkthrough run |
| 18 clear-draft | desktop | ⏳ pending | re-capture on next walkthrough run |
| 19 chat-pill | desktop | ⏳ pending | re-capture on next walkthrough run |
| 20 chat-full-again | desktop | ⏳ pending | re-capture on next walkthrough run |
| 21 input-focused | desktop | ⏳ pending | re-capture on next walkthrough run |
| 22 launcher | desktop | ⏳ pending | re-capture on next walkthrough run |
| 23 launch-view | desktop | ⏳ pending | re-capture on next walkthrough run |
| 24 chat-over-view | desktop | ⏳ pending | re-capture on next walkthrough run |
| 25 settings-edit | desktop | ⏳ pending | re-capture on next walkthrough run |
| 26 dashboard-rest | desktop | ⏳ pending | re-capture on next walkthrough run |
| 01 cold-launch | mobile | ⏳ pending | re-capture on next walkthrough run |
| 02 onboarding-runtime | mobile | ⏳ pending | re-capture on next walkthrough run |
| 03 onboarding-provider | mobile | ⏳ pending | re-capture on next walkthrough run |
| 04 provisioning-ready | mobile | ⏳ pending | re-capture on next walkthrough run |
| 05 tutorial | mobile | ⏳ pending | re-capture on next walkthrough run |
| 06 help | mobile | ⏳ pending | re-capture on next walkthrough run |
| 07 settings-open | mobile | ⏳ pending | re-capture on next walkthrough run |
| 08 wallet | mobile | ⏳ pending | re-capture on next walkthrough run |
| 09 chat-round-trip | mobile | ⏳ pending | re-capture on next walkthrough run |
| 10 chat-full-detent | mobile | ⏳ pending | re-capture on next walkthrough run |
| 11 chat-navigate-character | mobile | ⏳ pending | re-capture on next walkthrough run |
| 12 character-edit | mobile | ⏳ pending | re-capture on next walkthrough run |
| 13 new-chat | mobile | ⏳ pending | re-capture on next walkthrough run |
| 14 home-from-chat | mobile | ⏳ pending | re-capture on next walkthrough run |
| 15 restore-chat | mobile | ⏳ pending | re-capture on next walkthrough run |
| 16 copy-message | mobile | ⏳ pending | re-capture on next walkthrough run |
| 17 paste-large | mobile | ⏳ pending | re-capture on next walkthrough run |
| 18 clear-draft | mobile | ⏳ pending | re-capture on next walkthrough run |
| 19 chat-pill | mobile | ⏳ pending | re-capture on next walkthrough run |
| 20 chat-full-again | mobile | ⏳ pending | re-capture on next walkthrough run |
| 21 input-focused | mobile | ⏳ pending | re-capture on next walkthrough run |
| 22 launcher | mobile | ⏳ pending | re-capture on next walkthrough run |
| 23 launch-view | mobile | ⏳ pending | re-capture on next walkthrough run |
| 24 chat-over-view | mobile | ⏳ pending | re-capture on next walkthrough run |
| 25 settings-edit | mobile | ⏳ pending | re-capture on next walkthrough run |
| 26 dashboard-rest | mobile | ⏳ pending | re-capture on next walkthrough run |
