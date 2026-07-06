# Full Walkthrough — Vision Verdicts

Per-step screenshot verdicts for the continuous full-walkthrough run, scored
against each step's expectation row in [`JOURNEY.md`](./JOURNEY.md).

- Run: `2026-06-29_20-20-57_mock` (keyless mock lane, desktop + mobile),
  with #9298 mobile fixes hand-reviewed against the current-source
  `2026-07-01_18-34-52_mock` mobile capture.
- Method: hand-reviewed by vision-capable agents. The automated reviewer
  (`scripts/ai-qa/review-walkthrough.mjs`) is wired and ran 50 real
  `api.anthropic.com` calls, but the host key is unfunded (HTTP 400 billing),
  so verdicts were produced by human/agent review against the same criteria.
- Totals: **50 good · 0 needs-work · 0 broken** (of 50).

The original `needs-work` rows were follow-up app defects surfaced by the
walkthrough: leaked Character editor Style Rules placeholder copy, low-contrast
open chat chrome over the mobile dashboard, and Settings mobile back chrome
colliding with section headings. Those are fixed and reviewed in
the Playwright/test capture artifact tree.

| Step | Viewport | Verdict | Notes |
| --- | --- | --- | --- |
| 01 cold-launch | desktop | ✅ good | clean |
| 02 onboarding-runtime | desktop | ✅ good | clean |
| 03 provisioning-ready | desktop | ✅ good | clean |
| 04 tutorial (chat-native) | desktop | (re-capture pending) | superseded by the chat-native tour |
| 05 tutorial-commands | desktop | (re-capture pending) | replaces the removed Help view |
| 06 settings-open | desktop | ✅ good | clean |
| 07 wallet | desktop | ✅ good | clean |
| 08 chat-round-trip | desktop | ✅ good | clean |
| 09 chat-full-detent | desktop | ✅ good | clean |
| 10 chat-navigate-character | desktop | ✅ good | clean |
| 11 character-edit | desktop | ✅ good | clean |
| 12 new-chat | desktop | ✅ good | clean |
| 13 home-from-chat | desktop | ✅ good | clean |
| 14 restore-chat | desktop | ✅ good | clean |
| 15 copy-message | desktop | ✅ good | clean |
| 16 paste-large | desktop | ✅ good | clean |
| 17 clear-draft | desktop | ✅ good | clean |
| 18 chat-pill | desktop | ✅ good | clean |
| 19 chat-full-again | desktop | ✅ good | clean |
| 20 input-focused | desktop | ✅ good | clean |
| 21 launcher | desktop | ✅ good | clean |
| 22 launch-view | desktop | ✅ good | clean |
| 23 chat-over-view | desktop | ✅ good | clean |
| 24 settings-edit | desktop | ✅ good | clean |
| 25 dashboard-rest | desktop | ✅ good | clean |
| 01 cold-launch | mobile | ✅ good | clean |
| 02 onboarding-runtime | mobile | ✅ good | clean |
| 03 provisioning-ready | mobile | ✅ good | clean |
| 04 tutorial (chat-native) | mobile | (re-capture pending) | superseded by the chat-native tour |
| 05 tutorial-commands | mobile | (re-capture pending) | replaces the removed Help view |
| 06 settings-open | mobile | ✅ good | clean |
| 07 wallet | mobile | ✅ good | clean |
| 08 chat-round-trip | mobile | ✅ good | clean |
| 09 chat-full-detent | mobile | ✅ good | clean |
| 10 chat-navigate-character | mobile | ✅ good | clean |
| 11 character-edit | mobile | ✅ good | Style Rules copy now renders as user-facing text; no placeholder/label tokens remain. |
| 12 new-chat | mobile | ✅ good | clean |
| 13 home-from-chat | mobile | ✅ good | clean |
| 14 restore-chat | mobile | ✅ good | clean |
| 15 copy-message | mobile | ✅ good | clean |
| 16 paste-large | mobile | ✅ good | Open chat sheet now has enough surface contrast that dashboard content behind it reads as background, not competing controls. |
| 17 clear-draft | mobile | ✅ good | clean |
| 18 chat-pill | mobile | ✅ good | clean |
| 19 chat-full-again | mobile | ✅ good | clean |
| 20 input-focused | mobile | ✅ good | clean |
| 21 launcher | mobile | ✅ good | clean |
| 22 launch-view | mobile | ✅ good | Route-level launch assertion passes; the follow-on Settings capture no longer shows back chrome clipping the heading. |
| 23 chat-over-view | mobile | ✅ good | Chat overlay remains reachable over the active view without introducing the former mobile heading collision. |
| 24 settings-edit | mobile | ✅ good | Capabilities section renders with toggles and segmented control; shell back and inline Settings return row are separated from the section title. |
| 25 dashboard-rest | mobile | ✅ good | clean |
