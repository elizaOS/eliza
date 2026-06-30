# #10423 — per-app monetization attribution evidence

**Items 1–2 (inject the platform-authoritative `ELIZA_APP_ID` into deployed app
containers after the reserved-key strip):** landed in **#10433** —
`app-deploy-orchestrator.ts deployApp()` sets `ELIZA_APP_ID: req.appId`, adds it
to the strip denylist (caller cannot spoof), with `app-deploy-orchestrator.test.ts`
asserting the provisioned container carries it. Verified on develop (8/8 tests).

**Item 3 (end-to-end money chain):** the skip-gated e2e in
`packages/cloud/api/test/e2e/group-l-app-charges.test.ts` —
"monetized app: an inference charge attributes to the app's credits + creator
earnings (#10423)" — creates a monetized app (`monetization_enabled`,
`inference_markup_percentage`), baselines the org credit balance + app earnings,
drives `/api/v1/chat/completions` with `X-App-Id`, then polls and asserts the org
balance dropped (base+markup) **and** `total_creator_earnings` rose. It runs in
the staging e2e lane (gated on `TEST_API_KEY` + a reachable Worker + a provider
key), like every `group-*` e2e.

**Remaining (ops): run the e2e green against staging** — needs `TEST_API_BASE_URL`,
a `TEST_API_KEY` for an org owning the app, and a configured provider key. Attach
the run output here when executed.
