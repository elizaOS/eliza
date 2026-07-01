# Manual review — web app, multi-account settings (AI models)

Captured against a real running web app (`bun run dev`, isolated state dir seeded
with 2 Claude + 2 Codex accounts), Playwright, dark theme, desktop 1440 + mobile 390.

- **web-settings-claude-accounts-desktop.png** / **-mobile.png** — `Settings → Models & Providers → Claude Subscription`: `ACCOUNTS (2)` = **Personal (#0)** + **Work (#1)**, both **HEALTHY**, OAUTH, distinct usage (18% / 63%), `STRATEGY = Priority`, priority ordering (#0/#1 + up/down), Enable toggle, Test/Refresh, and **Add account**.
- **web-settings-codex-accounts-desktop.png** — same for `ChatGPT Subscription`: `ACCOUNTS (2)` Personal + Work, both HEALTHY.
- **web-settings-models-desktop.png** / **-mobile.png** — the provider overview: `Claude Subscription` + `ChatGPT Subscription` show green "connected" dots (the seeded multi-account pool).

## Verdict: good
- Two accounts per tier render with health, usage %, priority order, and the strategy picker — exactly the #10696 acceptance ("two accounts per tier appear in AccountList", "the strategy picker", "priority ordering").
- Brand-correct: orange accent (Add account, usage bars, Enabled), no blue.
- The heavy orange page wash is the app's ambient orange-pulse background at a high-intensity frame (a known aesthetic, not a regression); content is fully legible.
- This is the EXISTING settings surface (`AccountList`/`ProviderPanels`), unchanged by this PR — captured to prove the multi-account UI works with 2 accounts per tier.
