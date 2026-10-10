# @elizaos/plugin-personal-assistant

Owner operations and cross-domain personal-assistant orchestration for Eliza agents.

Composes owner operations across domain plugins. Use the shared scheduling runner,
entity/relationship stores, and attachment store. Load the database adapter and required
domain/connector plugins first. Household documents remain owner-private unless an
explicit current grant authorizes access.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-personal-assistant build  # build
bun run --cwd plugins/plugin-personal-assistant test   # tests
```

The managed morning brief follows authenticated owner foreground activity after the configured owner-day boundary (04:00 by default), with admission and day consumption persisted on its scheduled-task row. Manual refresh is separate; customized schedules are preserved. Android requires an authenticated user-present report with an unlocked, interactive device; iOS uses foreground events. Client reports are not OS attestation. Duplicate defaults and unresolved legacy delivery require reconciliation.


### Native bill task composition

`native-host/*.mjs` provides host-only bill discovery, complete PDF interpretation,
explicit source selection, durable submission/outcome records, and workflow
composition over the agent's `InteractiveTaskRuntime` and browser's
`NativeTaskActuator`. It reuses the host's task database and owner authorization;
it does not create a scheduler, connector identity, autonomous payment action,
or replacement task engine. `bill_outcomes_v1` and source/attempt/review tables
are task-owned domain evidence, including uncertain submissions that must survive
restarts to prevent repeated preparation. With a journal path, a submission
attempt is journaled with fsync before its INSERT and written again at the next
start. A form the person sent on the biller's website while the task was paused
or restarted, other than a sign-in or code form, is an uncertain submission even
without a payment review. A page that the browser stopped from submitting after
a task action pauses the task. A website that already shows the bill paid or
scheduled ends the task with a kept `bill_prior_outcomes_v1` record; it is never
this task's payment. After a saved outcome, a host with bill discovery looks up
to three times for exactly one receipt email that names the provider reference
and then reports `receiptInEmail`. Each lookup reserves a durable attempt before
the provider read; failed reads share the same budget and one-minute cooldown.
The code coordinator never fills a code field
the person has typed in and reports fixed Google reasons (`codeReason`). Bill
search fails with `account_mismatch` when the connected Google address cannot
receive the configured recipient's mail (masked addresses are matched by their
visible parts).

Hosts must supply reviewed `deriveBillDecision` and exact `controls` policy.
Neither may come from renderer input, page instructions or a model response.
The policy can return a decision or a promise. An asynchronous policy receives
the task's cancellation signal in its third-argument context. The workflow rechecks
authority, task state and a fresh browser observation before using that result.
Changed page facts discard the result; no choice, review or outcome is saved.
For person-only steps, reviewed policy may return `guidanceTarget` with an exact
observed element reference. The workflow rebinds it after an unchanged fresh
observation and shows the guide. A missing reference clears the guide. This does
not grant click or submit permission; existing-method selection keeps its fixed
reviewed control policy.
Payment reviews use `paymentDate: null` when the page does not show a date.
Unknown dates stay null in saved evidence and client responses.
Bill-source parsing and provider/account scope are also explicit host inputs.
The plugin's confidence-based `src/lifeops/bill-extraction.ts` remains a separate
inbox classification API; its result alone is not payment authorization.
The test-biller text contract and control labels exist only in test fixtures.
Application packaging, private startup configuration, and UI remain with hosts.

Run `bun run test:bill-host` for discovery, revocation, exact-money parsing,
selection, SQLite durability and submission-uncertainty checks. These tests use
synthetic connectors and real task/SQLite persistence where applicable; they do
not prove live account or biller acceptance.

`createBillTaskRoutes` composes bill discovery/selection, review choices and latest
outcomes into the app task gateway extension. It receives the existing task
runtime, SQLite stores, workflow policy and four required presentation strings
from the host. Authorization is rechecked after asynchronous work; source
selection and duplicate choice delivery retain their durable task bindings.
Product helper descriptions, support/study routes and UI copy stay with hosts.

The native bill-outcome store's `loadEvidence()` returns the current observation
and whether that exact validated record is persisted. Host reports can distinguish
pending observations from durable evidence without querying the store's tables.

`native-host/bill-client.ts` is a browser-safe client leaf for these routes. It
validates response snapshots with injected shared choice/money validators, owns
request state and task-switch cancellation, and never replays uncertain source
selection. Source-link opening requires an explicit call and validated provider
URL. Hosts supply transport and UI wording; owner authorization and durable effect
controls remain on the host. Stopping a client suppresses late replies, not host
effects already dispatched. The leaf is exported as `./native-host/bill-client`.
`BillDecisionClient.hold()` suspends timed re-checks while a question is answered;
a command started meanwhile is sent only after `release()`.


`native-host/bill-review-controller.ts` sequences explicitly requested bill metadata
search, message read, review admission, observation and submission through host ports.
Cancellation and bill identity changes suppress stale callbacks; cancellation drops
cached message selection but retains durable uncertainty. Submission ports must call
`beforeDispatch` immediately before the effect and abort if it throws. A pending marker
forces observation-only reconciliation; null, failed or unknown observations never
clear that marker or trigger automatic resubmission. The host scopes storage to owner,
account and bill and supplies authorization, provider matching, UI stages and copy.
`LatestOutcomeController` admits task identifiers and fences stale read-only results.
Current lookup failures reject for host error reporting without clearing the last result.
These clients do not grant payment authority or start work without an explicit call.
Run `npm run test:bill-host` for their sequencing and uncertainty regressions.

`native-host/configured-bill-helper.mjs` composes a reviewed helper configuration
with the native browser target, managed bill/PDF discovery and private evidence
files. Hosts supply configuration validation, bill controls, authorization and
observation policy, parsing, evidence projection/namespace and presentation.
Native profile and task-owner/goal fences are checked before delegated operations.
Closing is idempotent and attempts both host and native cleanup even after an
exception; startup rollback preserves the original failure and cleanup errors.
Real local-socket and private-file tests cover these boundaries; they do not
establish live browser, provider or device acceptance.
`currentPage(owner)` returns the configured profile's current page as
`{ origin, title }`, or `null` for another owner, a changed account or profile,
a closed helper, an older browser or an unknown page. Hosts can use it to tell
the conversation which website is open beside it, for example in an Android
browser split, where the dock state has no page.

`native-host/load-configured-bill-helper.mjs` loads explicit helper configuration,
passes the task artifact's source identity to the reviewed document loader, and
binds document/Google ports to the configured actor and grant. Only an explicitly
optional missing file is ignored; invalid configuration or provenance fails closed.
It imports the selected runtime through a file URL, preserving paths with spaces.

Existing-method selection persists immutable owner/task/operation-bound review
metadata before dispatch. Missing or failed storage prevents the click; selection
records are distinct from payment attempts. `createBillHelperHost.reconcileTask`
binds exactly one unknown operation to its saved review and delegates to the
existing read-only runtime/actuator reconciliation path, without replaying it.
Hosts supply `reconcileMethod` policy. Configured hosts may additionally supply
`reconciliationEvidenceRecord`; conclusive readback is published only after its
projected evidence is privately persisted. Unknown observations remain unknown.

Hosts may require current on-screen guidance before offering/selecting a saved
method by supplying `selectionGuidance: { unavailableMessage }` to the bill helper
or workflow. Copy stays host-owned. Missing, ambiguous or rejected guidance yields
human review and no selection record/click. If guidance disappears after a choice
was offered, the explicit failed attempt pauses the task and settles cleanup;
explicit Resume obtains a fresh epoch/choice instead of reusing a consumed choice.
Omitting this policy preserves headless hosts' existing behavior.

Configured native bill hosts wait for the exact expected browser profile before
a new task binding after service restart. The browser transport owns the bounded
registration wait; the configured host rechecks account authority and profile
after it. Closing the host cancels pending waits. Revocation cleanup, guidance
and browser commands never enter this wait or replay a request. Product page
policy must allow binding to reach this gate rather than rejecting a temporarily
unregistered profile during pure policy construction.
