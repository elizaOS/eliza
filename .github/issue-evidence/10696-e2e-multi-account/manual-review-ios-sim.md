# Manual review — iOS simulator, multi-account (real captures)

iPhone 16 Pro simulator (iOS), Eliza app + the seeded web app (127.0.0.1:2138,
2 Claude + 2 Codex accounts on the backend), captured via `xcrun simctl io
screenshot` + driven with `idb ui tap`/`swipe` (device-point coords). No Screen
Recording permission needed — simctl reads the sim framebuffer directly.

- **ios-sim-launch.png** — native Eliza app running (home screen).
- **ios-settings-menu.png** — Settings → Agent (Basics, Models & Providers, …).
- **ios-models.png** — Models & Providers: `Claude Subscription` + `ChatGPT
  Subscription` with green "connected" dots (the seeded pool).
- **ios-claude-accounts.png** — Claude Subscription `ACCOUNTS (2)`: Personal (#0)
  + Work (#1), both **HEALTHY**, OAUTH, usage 18% / 63%, `STRATEGY = Priority`,
  priority order, Enable/Test/Refresh, **Add account**.
- **ios-codex-accounts.png** — ChatGPT Subscription `ACCOUNTS (2)`: Personal (#0)
  + Work (#1), both **HEALTHY**, SESSION 18% / 63%.

## Verdict: good
Two accounts per tier (Claude + Codex) render on the iOS simulator with health,
usage, priority order, and the strategy picker — the #10696 acceptance, on iOS.
Brand-correct (orange accent, no blue); legible. Same shared shell renders on a
real device (two iPhones paired: Shaw's iPhone 15 Pro, MoonCycles iPhone 16 Pro Max).
