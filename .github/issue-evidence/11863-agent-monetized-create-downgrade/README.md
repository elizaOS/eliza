# #11863 — agent "create a monetized app" no longer dead-ends on a 403

## Contract change (per the issue's guidance)

`POST /api/v1/apps` with `monetization_enabled: true` no longer rejects with
`403 app_review_required`. Instead it:

- creates the app (success on creation),
- **forces monetization off** (fail-closed on money — the enable flag is never
  honored at create time; the same approved-review gate as
  `PUT /apps/:id/monetization` still applies),
- persists a requested `inference_markup_percentage` as a pricing default so
  approval needs no re-entry,
- pushes `CREATE_TIME_MONETIZATION_WARNING` into the response `warnings`
  array telling the caller the exact next step (submit for review via the
  Monetize tab or `POST /api/v1/apps/:id/review`),
- returns `app.review_status` (`"draft"`) as the structured review-status DTO
  field.

The agent one-shot flow (`plugins/plugin-cloud-apps` `CREATE_APP`) keeps
sending the user's monetization intent; it relays the server warning into the
chat reply and now also returns `reviewStatus` in the action result data.

## Evidence

- `fail-without-fix-integration.txt` — the new integration test
  (`packages/cloud/api/__tests__/apps-crud.integration.test.ts`, "create-time
  monetization enablement is downgraded") run against the pre-fix route at
  `origin/develop` `a747ced409`: **Expected 200, Received 403 → 1 fail**.
  Post-fix: 41 pass / 0 fail.
- `scenario-report.json` — deterministic scenario
  `cloud-apps-create-monetized-review` (new): drives the real `CREATE_APP`
  action through the real SDK client over HTTP against a loopback cloud API
  implementing the new contract. Asserts: app created, reply surfaces the
  review next-step, no "Monetization is on" false claim, no API-key leak,
  result data `monetization=false` + `reviewStatus="draft"`, and exactly one
  `POST /api/v1/apps` carrying `monetization_enabled: true` +
  `inference_markup_percentage: 20`.
- `verification.txt` — local test/typecheck/lint runs (CI rarely completes;
  local runs are the merge gate).

## N/A evidence

- Screenshots / video / frontend logs: N/A — no UI change. The dashboard
  create flow never sends `monetization_enabled: true` (it got the
  review-gated Monetize tab in #11828); this fix is the API contract + the
  agent connector flow, which has no rendered surface beyond the chat text
  asserted in the scenario report.
- Real-LLM trajectory: N/A — the action's prompt/planner behavior is
  unchanged; only the HTTP contract and reply composition changed, both
  covered by the deterministic scenario (SCENARIO_USE_LLM_PROXY lane) and
  unit/integration tests.
- Live-Worker e2e (`group-i-apps-lifecycle.test.ts`): test updated to the new
  contract; runs as counted skips locally without a bootstrapped Worker +
  TEST_API_KEY (same as #11828's evidence run).
