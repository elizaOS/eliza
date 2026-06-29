# Full Walkthrough — Vision Verdicts

Per-step screenshot verdicts for the continuous full-walkthrough run, scored
against each step's expectation row in [`JOURNEY.md`](./JOURNEY.md).

- Run: `2026-06-29_20-20-57_mock` (keyless mock lane, desktop + mobile)
- Method: hand-reviewed by vision-capable agents. The automated reviewer
  (`scripts/ai-qa/review-walkthrough.mjs`) is wired and ran 50 real
  `api.anthropic.com` calls, but the host key is unfunded (HTTP 400 billing),
  so verdicts were produced by human/agent review against the same criteria.
- Totals: **45 good · 5 needs-work · 0 broken** (of 50). Gate passes (0 broken).

The `needs-work` rows are **pre-existing app defects the walkthrough surfaced**
(out of scope to fix per #10198 — it drives/records existing surfaces, it does
not change them): the character editor leaks i18n placeholder keys in its Style
Rules section, and the settings floating back-button overlaps the sidebar title.

| Step | Viewport | Verdict | Notes |
| --- | --- | --- | --- |
| 01 cold-launch | desktop | ✅ good | clean |
| 02 onboarding-runtime | desktop | ✅ good | clean |
| 03 provisioning-ready | desktop | ✅ good | clean |
| 04 tutorial | desktop | ✅ good | clean |
| 05 help | desktop | ✅ good | clean |
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
| 04 tutorial | mobile | ✅ good | clean |
| 05 help | mobile | ✅ good | clean |
| 06 settings-open | mobile | ✅ good | clean |
| 07 wallet | mobile | ✅ good | clean |
| 08 chat-round-trip | mobile | ✅ good | clean |
| 09 chat-full-detent | mobile | ✅ good | clean |
| 10 chat-navigate-character | mobile | ✅ good | clean |
| 11 character-edit | mobile | 🟡 needs-work | Three labels render as leaked placeholder/label tokens instead of real copy: 'Style Rules Header', 'Style Rules Help', and the button 'Add Style Rule Short'.; Otherwise the Persona |
| 12 new-chat | mobile | ✅ good | clean |
| 13 home-from-chat | mobile | ✅ good | clean |
| 14 restore-chat | mobile | ✅ good | clean |
| 15 copy-message | mobile | ✅ good | clean |
| 16 paste-large | mobile | 🟡 needs-work | The chat sheet's drag handle and toolbar buttons (expand/copy/refresh and grid) overlap the home dashboard cards behind them ('W… just now' / 'Connect cal…' / 'Dismiss' row), colli |
| 17 clear-draft | mobile | ✅ good | clean |
| 18 chat-pill | mobile | ✅ good | clean |
| 19 chat-full-again | mobile | ✅ good | clean |
| 20 input-focused | mobile | ✅ good | clean |
| 21 launcher | mobile | ✅ good | clean |
| 22 launch-view | mobile | 🟡 needs-work | Launched Settings view content is correct (Agent + System sections with rows), satisfying 'not the launcher grid'.; Defect: the floating circular back button overlaps and clips the |
| 23 chat-over-view | mobile | 🟡 needs-work | Chat overlay is correctly reachable over the Settings view (shows 'open my character' / 'Saved — walkthrough reply captured'), meeting expectation.; Defect: same header issue — the |
| 24 settings-edit | mobile | 🟡 needs-work | Capabilities section renders with toggles (Wallet/Browser ON in orange, Computer Use/Auto-training off) and a Proactive-suggestions Off/Subtle/Chatty segmented control — matches th |
| 25 dashboard-rest | mobile | ✅ good | clean |
