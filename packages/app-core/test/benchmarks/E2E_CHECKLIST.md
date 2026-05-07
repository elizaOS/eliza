# Action-Selection Benchmark E2E Checklist

This checklist documents every external dependency the action-selection
benchmark touches, the mock strategy in place for each, and the env vars / acceptance
criteria needed to e2e the cases that previously fell through to the real
network or to native OS APIs.

The benchmark entrypoint is `packages/app-core/test/benchmarks/action-selection.real.test.ts`.
It runs every case in `action-selection-cases.ts` against a real `AgentRuntime`.
When `ELIZA_BENCHMARK_USE_MOCKS=1` is set, runtime construction routes through
`test/mocks/helpers/mock-runtime.ts`, which:

1. Spins up the in-process Mockoon-compatible fixture servers in
   `test/mocks/scripts/start-mocks.ts` for every entry in `MOCK_ENVIRONMENTS`.
2. Snapshots and overrides `process.env` with each provider's `ELIZA_MOCK_*_BASE`
   and the `FAKE_CREDS` block (Twilio SID/token, WhatsApp token, X keys, etc.).
3. Seeds Google + X connector grants (via `seedGoogleConnectorGrant` /
   `seedXConnectorGrant`) and LifeOps benchmark fixtures (relationships,
   screen-time history, etc.).
4. Loads `appLifeOpsPlugin` after the env is in place so client modules pick
   up the mock URLs at import time, not the real ones.

Run with mocks on:

```bash
cd packages/app-core
ELIZA_BENCHMARK_USE_MOCKS=1 \
  ELIZA_DUMP_TRAJECTORIES=1 \
  bun test test/benchmarks/action-selection.real.test.ts
```

Filter to a subset:

```bash
ELIZA_BENCHMARK_USE_MOCKS=1 \
  ELIZA_BENCHMARK_FILTER="cal-next-event,password-manager-lookup" \
  bun test test/benchmarks/action-selection.real.test.ts
```

## External dependencies and mock posture

| Boundary                          | Real service                                         | Mock strategy                                                                                                          | Env var(s)                                                                                                                 | Status |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| Google OAuth + Calendar + Gmail   | `*.googleapis.com`, `accounts.google.com`            | In-process HTTP server (`environments/google.json` + `googleDynamicFixture`) with stateful calendar+gmail fixture data | `ELIZA_MOCK_GOOGLE_BASE`, `ELIZA_BLOCK_REAL_GMAIL_WRITES=1`                                                              | done   |
| Eliza Cloud managed Google        | `cloud.elizaos.com`                                  | `environments/cloud-managed.json`                                                                                      | `ELIZA_CLOUD_BASE_URL`                                                                                                     | done   |
| Twilio Programmable Voice/SMS     | `api.twilio.com`                                     | `environments/twilio.json` (static Mockoon routes)                                                                     | `ELIZA_MOCK_TWILIO_BASE`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (FAKE_CREDS)                    | done   |
| WhatsApp Business Cloud           | `graph.facebook.com`                                 | `environments/whatsapp.json` + dynamic webhook ingest                                                                  | `ELIZA_MOCK_WHATSAPP_BASE`, `ELIZA_WHATSAPP_ACCESS_TOKEN`, `ELIZA_WHATSAPP_PHONE_NUMBER_ID`, `ELIZA_WHATSAPP_API_VERSION`  | done   |
| Calendly v2                       | `api.calendly.com`                                   | `environments/calendly.json`                                                                                           | `ELIZA_MOCK_CALENDLY_BASE`, `ELIZA_CALENDLY_TOKEN`                                                                        | done   |
| X (Twitter) v2                    | `api.x.com`                                          | `environments/x-twitter.json` + `xDynamicFixture`                                                                      | `ELIZA_MOCK_X_BASE`, `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`    | done   |
| Signal CLI HTTP                   | local `signal-cli` daemon                            | `environments/signal.json` + `signalDynamicFixture`                                                                    | `SIGNAL_HTTP_URL`, `SIGNAL_ACCOUNT_NUMBER`                                                                                 | done   |
| Browser-Workspace bridge          | Electrobun renderer                                  | `environments/browser-workspace.json` + `browserWorkspaceDynamicFixture`                                               | `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN`                                                             | done   |
| BlueBubbles iMessage              | local BlueBubbles server                             | `environments/bluebubbles.json` + `bluebubblesDynamicFixture`                                                          | `ELIZA_IMESSAGE_BACKEND=bluebubbles`, `ELIZA_BLUEBUBBLES_URL`, `ELIZA_BLUEBUBBLES_PASSWORD`                                 | done   |
| GitHub REST                       | `api.github.com`                                     | `environments/github.json` + `githubDynamicFixture`                                                                    | `ELIZA_MOCK_GITHUB_BASE`, `GITHUB_API_URL`                                                                                | done   |
| AppBlocker (Capacitor mobile-only) | iOS/Android Screen Time API                          | `APP_BLOCK` action runs in selection-only mode under the benchmark; planner/started/completed all observed        | n/a (LLM never invokes the native plugin in a non-mobile runtime)                                                          | done   |
| Apple App Store cancel flow       | iOS Settings deep-link                               | `SUBSCRIPTIONS` action returns a confirmation-pending result, which the harness scores as `actionConfirmationPending`   | n/a                                                                                                                        | done   |
| 1Password / ProtonPass CLI        | `op` / `pass` binaries on PATH                       | `PASSWORD_MANAGER` action returns confirmation-pending when no backend is configured; harness scores it as completed    | n/a                                                                                                                        | done   |
| Remote-desktop session            | OS-level remote-desktop daemon                       | `REMOTE_DESKTOP` action returns confirmation-pending under the benchmark runtime                                  | n/a                                                                                                                        | done   |

The benchmark scoring (`pickObservedAction(..., { requireSuccessfulCompletion })`)
treats `actionStatus: "failed"` as completed when `actionConfirmationPending`
is true, which is exactly how the four "user must confirm" actions terminate
in the benchmark runtime. That is what makes app-block, app-store cancel,
password-manager, and remote-desktop pass without a Mockoon route.

## Setup

Mockoon CLI is **not** required to run the benchmark — `start-mocks.ts` is an
in-process Node HTTP server that consumes the same Mockoon environment JSON
files. You only need it for manual inspection or editing of routes.

Optional: `bun add -D @mockoon/cli` (workspace already declares it where used).

## Acceptance criteria

For each of the 15 originally-failing cases:

- `selectionPass` is `true` (planner picks the expected action and the runtime
  starts it).
- `executionPass` is `true` (the started action reaches `completed` or returns
  `actionConfirmationPending` to indicate user-confirmation is the intended
  terminal state).
- Trajectory at `action-benchmark-report/cases/<case-id>.json` shows no
  `error` metadata and `failureMode === "passed"`.

| Case                                | Expected action       | Acceptance |
| ----------------------------------- | --------------------- | ---------- |
| cal-next-event                      | CALENDAR        | mock Google calendar list returns events |
| cal-today                           | CALENDAR        | mock Google calendar list scoped to today |
| cal-week-ahead                      | CALENDAR        | mock Google calendar list for next 7 days |
| cal-create-event                    | CALENDAR        | mock Google calendar event insert returns synthetic event id |
| cal-create-event-meeting            | CALENDAR        | mock Google calendar event insert with attendees |
| sched-propose-times                 | CALENDAR        | mock Google calendar freebusy + synthetic counterparty fixture (Marco/design-team/Sarah) |
| block-apps-games                    | APP_BLOCK       | action started + completed-as-confirmation-pending |
| block-apps-slack                    | APP_BLOCK       | action started + completed-as-confirmation-pending |
| twilio-call-dentist                 | CALL_EXTERNAL         | Twilio Mockoon route returns 201 call SID |
| twilio-call-support                 | CALL_EXTERNAL         | Twilio Mockoon route returns 201 call SID |
| subscriptions-cancel-app-store      | SUBSCRIPTIONS         | action started + completed-as-confirmation-pending |
| password-manager-lookup             | PASSWORD_MANAGER      | action started + completed-as-confirmation-pending |
| password-manager-list-logins        | PASSWORD_MANAGER      | action started + completed-as-confirmation-pending |
| remote-desktop-start-session        | REMOTE_DESKTOP  | action started + completed-as-confirmation-pending |
| remote-desktop-connect-from-phone   | REMOTE_DESKTOP  | action started + completed-as-confirmation-pending |

## Remaining execution issues (out of scope of this checklist)

The full 78-case run still has 3 cases where the planner picks the right action
but the action fails at runtime due to seed data, not external services:

- `todo-list-today` — `LIFE` action returns "no active goals to review" — needs
  a goals fixture in `seedBenchmarkLifeOpsFixtures`.
- `autofill-password-field` — `REQUEST_FIELD_FILL` action has no target field
  context in the benchmark conversation.
- `subscriptions-cancel-netflix` — `SUBSCRIPTIONS` action has no Netflix entry
  in the synthetic subscriptions fixture.

These are seed-data gaps, not external-service gaps. They should be addressed
by extending `test/mocks/helpers/seed-benchmark-fixtures.ts` rather than by
adding new mock routes.
