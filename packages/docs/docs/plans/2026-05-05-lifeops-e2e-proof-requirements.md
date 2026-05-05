# LifeOps E2E Proof Requirements

Status: Required standard for new and revised LifeOps E2E/scenario plans

Related standards:

- [LifeOps Proof Taxonomy](2026-05-05-lifeops-proof-taxonomy.md)
- [LifeOps Connector API Mock Proof Standard](2026-05-05-lifeops-connector-proof-standard.md)
- [LifeOps Account And Credential Matrix](2026-05-05-lifeops-account-credential-matrix.md)
- [LifeOps Shared Dependency Ownership Map](2026-05-05-lifeops-shared-ownership-map.md)

## Purpose

Every LifeOps E2E or scenario plan must prove behavior with inspectable evidence, not plausible chat output. The Gmail proof standard is the model: typed action calls, typed outputs, approval transitions, database or ledger side effects, mock-provider request evidence, no-real-write proof, and LLM judges for semantic quality only.

This document applies to scenario plans under `docs/plans`, executable scenarios under `test/scenarios`, and live E2E plans that use the LifeOps app, connectors, background jobs, mobile transports, dashboard UI, or passive inference.

## Required Fields For Every Scenario Plan

Each scenario row or scenario file must name these fields explicitly:

| Field | Requirement |
| --- | --- |
| Scenario ID | Stable dotted ID that maps to the executable scenario or future test file. |
| User request or trigger | Exact user utterance, inbound event, scheduled tick, UI action, or mobile transport event that starts the scenario. |
| Seeded facts | Concrete seeded state the run depends on: people, messages, grants, calendars, tasks, habits, device state, provider records, timestamps, and policy memory. Seeds must use semantic identifiers, not hardcoded provider fixture IDs as the proof target. |
| Expected structured outputs | Typed action name, typed arguments, DTO fields, event payload, approval request, workflow dispatch, database row, or UI data model that must exist after the run. |
| Side effects | Observable writes or non-writes: connector dispatch, provider mock request, DB insert/update/delete, approval queue transition, notification, draft, delivery, workflow dispatch, browser task state, mobile transport send, or dashboard state update. |
| Negative path | The unsafe, stale, ambiguous, disconnected, missing-scope, rate-limited, too-broad, duplicate, or transport-offline variant that must refuse, clarify, degrade, or retry without incorrect writes. |
| Cleanup | Per-run cleanup path for all created state. Real-provider writes require dry-run-first sweepers, exact run IDs, allowlists, and a documented execute gate. Mock-only cleanup must reset fixture state or isolate per scenario. |
| Provider ledger proof | Mock or provider ledger evidence with method/channel/path/action, typed body metadata, selected target, account/grant, request ID or run ID, and assertion that real providers were not touched when in mock mode. |
| LLM judge use | Rubric name, threshold, and scope. Judges may score semantic prioritization, rationale quality, and whether a refusal or clarification is appropriate. Judges must not replace action-shape, side-effect, ledger, or cleanup assertions. |
| UI assertions where applicable | Required for dashboard, browser, mobile, approval, and notification flows: visible state, affordance state, disabled/enabled controls, route, refresh behavior, and absence of stale/duplicate UI items. |
| Skip policy | Exact skip conditions and whether skips fail CI. Missing required credentials or unsupported platform may skip only non-release suites. Release-critical suites must fail on unexpected skips and report the missing prerequisite. |

## Allowed Proof

- Structured action call captured with action name and typed arguments.
- Structured final checks such as `selectedAction`, `approvalRequestExists`, `approvalStateTransition`, `connectorDispatchOccurred`, `memoryWriteOccurred`, `gmailMockRequest`, `gmailNoRealWrite`, `n8nDispatchOccurred`, or a typed `custom` predicate.
- DTO fields returned by LifeOps use cases, route clients, or connector adapters.
- Persisted DB rows and state transitions read after the run.
- Provider or mock request ledger entries with typed request metadata.
- UI assertions from a real browser/app surface when the scenario covers dashboard, approval, mobile, or notification behavior.
- LLM judge rubric for semantic quality only.

## Disallowed Proof

- Response text contains a success word such as "sent", "done", "archived", or "scheduled".
- Regex or substring checks as the only proof of action selection or execution.
- Serialized action blob string matching as proof when typed arguments or typed final checks are available.
- Final checks that pass because unknown assertion fields are ignored.
- Hardcoded provider fixture IDs as the proof target instead of seeded facts and dynamic target selection.
- Real-provider write scenarios without run ID, allowlist, dry-run cleanup, and provider ledger proof.

## Cross-Cutting Rules

1. Scenario plans must separate semantic judgment from execution proof. The judge can say whether the assistant understood the request; typed assertions must prove what it did.
2. Writes must be tied to prior target discovery. A send, archive, schedule change, workflow dispatch, or mobile push must point back to the seeded fact it selected.
3. Approval-gated writes must prove both pending and confirmed/rejected states. Generic consent is not enough when the target changed or was not named.
4. Negative paths must assert absence of side effects. A refusal path is incomplete unless it proves no provider write, no connector dispatch, no stale approval execution, or no duplicate persisted row.
5. Mock mode must prove all provider traffic stayed on the mock or loopback provider ledger. Real mode must prove scope, account/grant, run ID, allowlist, and cleanup.
6. Scenario seeds must be inspectable after normalization. Personal captures, raw provider IDs, raw email addresses, tokens, attachments, and non-test domains are not acceptable committed fixtures.
7. Release-critical scenario packs must fail on missing proof fields, unknown final-check fields, old helper-only substring assertions, missing judge rubrics, and unexpected skips.

## Scenario Templates

Use these templates when adding or revising plans. Add domain-specific rows, but do not remove the required proof fields.

### Connector Actions

| Field | Template |
| --- | --- |
| Scenario ID | `connector.<provider>.<capability>.<path>` |
| User request or trigger | User asks for a read, draft, send, modify, search, or delivery action through the connector. |
| Seeded facts | Connector grant with account ID/scopes; provider fixture records with semantic labels; owner policy memory; target contact or thread; current time. |
| Expected structured outputs | Selected connector action; typed provider/channel arguments; account/grant ID; selected semantic target; returned DTO fields. |
| Side effects | Provider mock ledger read/write; connector dispatch row; draft/delivery/modify result; memory write where certification requires traceability. |
| Negative path | Missing scope, disconnected account, auth expired, rate limit, delivery degraded, too-broad destructive request, or stale confirmation. |
| Cleanup | Delete drafts/messages/labels created by the run; reset mock ledger; in real mode use exact run ID, recipient allowlist, dry-run sweep, then explicit execute. |
| Provider ledger proof | Assert method/channel/path, body metadata, account/grant, selected target, run ID, and no traffic to real provider in mock mode. |
| LLM judge use | Score target selection and summary/refusal quality; do not score whether a provider write happened. |
| UI assertions where applicable | Approval queue item, connector status, action result toast/list row, disabled unsafe action until approval. |
| Skip policy | Missing mock provider is failure. Missing real credentials may skip only real-read smoke suites with explicit reason. |

### Background And Tick Jobs

| Field | Template |
| --- | --- |
| Scenario ID | `lifeops.<domain>.tick.<path>` |
| User request or trigger | Clock tick, cron event, startup hook, provider webhook, calendar boundary, reminder due time, or habit/routine window. |
| Seeded facts | Frozen `now`; due and not-due records; owner timezone; connector grants; previous tick cursor; idempotency key; policy memory. |
| Expected structured outputs | Job result DTO; created task/event/notification/workflow payload; updated cursor; idempotency outcome. |
| Side effects | DB rows updated exactly once; notification or connector dispatch; workflow event persisted; no action for filtered records. |
| Negative path | Duplicate tick, late tick, disabled automation, connector unavailable, filter mismatch, rate limit, or partial failure. |
| Cleanup | Delete created rows by run ID; reset cursors; clear queued notifications and mock ledger. |
| Provider ledger proof | Assert only due records generated provider/transport calls and duplicate ticks did not dispatch twice. |
| LLM judge use | Score semantic classification or prioritization when the job invokes an LLM; otherwise omit judge and use structured assertions. |
| UI assertions where applicable | Dashboard reflects new/updated job outcome after refresh and does not show duplicate cards. |
| Skip policy | Time-dependent release suites must not skip because of wall-clock drift; they must use frozen time. |

### Approval-Gated Writes

| Field | Template |
| --- | --- |
| Scenario ID | `lifeops.approval.<action>.<path>` |
| User request or trigger | User requests a write that must be held for approval, then confirms, rejects, or changes context. |
| Seeded facts | Target record; current target version; owner approval policy; pending approval queue state if testing continuation; provider grant. |
| Expected structured outputs | Pending approval with typed action, selected target, diff/body, risk level, expiry, and confirmation token or approval ID. |
| Side effects | Pending state after first turn; confirmed transition writes exactly once; rejected/stale transition writes nothing; audit row. |
| Negative path | Generic confirmation, stale approval after target changes, expired hold, rejected approval, or destructive request without target. |
| Cleanup | Cancel remaining pending approvals; remove created provider artifacts; reset audit rows by run ID. |
| Provider ledger proof | Assert no provider write before approval, one matching write after valid confirmation, and no write after reject/stale/expired confirmation. |
| LLM judge use | Score whether the assistant asked for the right clarification/refusal and summarized the risk accurately. |
| UI assertions where applicable | Approval card shows exact target and diff; confirm/reject controls work; stale/expired cards cannot execute. |
| Skip policy | Approval-gated write suites are release-critical and must fail on unexpected skips. |

### Dashboard UI

| Field | Template |
| --- | --- |
| Scenario ID | `lifeops.dashboard.<surface>.<path>` |
| User request or trigger | User opens dashboard route, changes filter, reviews recommendation, approves write, or refreshes after backend state changes. |
| Seeded facts | Backend rows for cards/lists/counts; connector status; approval queue; recommendations; job outcomes; owner profile and timezone. |
| Expected structured outputs | Route data model, UI state, selected row/card identity, action payload emitted by UI, and backend mutation result. |
| Side effects | UI-triggered route/client call; approval transition; recommendation status update; DB row mutation; provider ledger entry only when confirmed. |
| Negative path | Empty state, loading/error state, stale data refresh, offline connector, unauthorized write, duplicate click, or failed mutation. |
| Cleanup | Reset seeded rows and browser storage; clear approvals and mock provider requests. |
| Provider ledger proof | For UI writes, assert the same provider ledger evidence as API scenarios and tie it to the UI-selected item. |
| LLM judge use | Usually not required for pure UI assertions; use only when UI invokes an LLM-generated recommendation or summary. |
| UI assertions where applicable | Required: route renders, critical text/data visible, controls enabled/disabled correctly, mutation result visible, no overlapping/stale duplicate elements. |
| Skip policy | Browser unavailable may skip non-release visual smoke only. Release dashboard proof must fail if the route cannot be exercised. |

### Mobile Transport

| Field | Template |
| --- | --- |
| Scenario ID | `lifeops.mobile.<transport>.<path>` |
| User request or trigger | Push, SMS, voice, notification tap, mobile reply, offline queue replay, or device-specific escalation. |
| Seeded facts | Device registration; transport capability; user contact route; notification policy; pending task/approval; delivery state; current device online/offline. |
| Expected structured outputs | Transport action with typed destination, message kind, priority, correlation/run ID, and fallback/escalation plan. |
| Side effects | Provider/transport ledger dispatch; delivery/ack row; escalation state; no duplicate send on retry; approval state if reply confirms. |
| Negative path | Transport offline, revoked token, delivery degraded, duplicate webhook, wrong device, ambiguous reply, or reply from untrusted sender. |
| Cleanup | Clear notification queue, delivery rows, device test registration, and provider messages by run ID where possible. |
| Provider ledger proof | Assert dispatch channel, destination/device, payload metadata, correlation/run ID, retry/idempotency key, and no send to non-seeded contact. |
| LLM judge use | Score escalation wording or interpretation of a mobile reply; do not use it as delivery proof. |
| UI assertions where applicable | Mobile/dashboard surfaces show sent, acknowledged, failed, or needs-human state consistently across refresh. |
| Skip policy | Platform-specific suites may skip only when the named simulator/device transport is unavailable and the skip is not release-critical. |

### Passive Schedule Inference

| Field | Template |
| --- | --- |
| Scenario ID | `lifeops.schedule-inference.<signal>.<path>` |
| User request or trigger | Passive signal arrives from calendar, Gmail, browser activity, mobile location-like state, reminder completion, or repeated behavior. |
| Seeded facts | Multiple corroborating and conflicting signals; owner timezone; existing schedule/preferences; confidence threshold; previous inference state. |
| Expected structured outputs | Inference DTO with evidence IDs, confidence, proposed schedule/preference, uncertainty reason, and whether approval is required. |
| Side effects | Persisted inference/proposal; no schedule mutation until approved if confidence or policy requires it; notification/recommendation if user review is needed. |
| Negative path | Insufficient evidence, conflicting signals, privacy-redacted signal, stale observation, timezone boundary, or one-off anomaly. |
| Cleanup | Delete inference/proposal rows, reset preference state, clear notification/provider ledger entries. |
| Provider ledger proof | Assert read-only provider access for signal collection and no calendar/task write unless a later approval scenario confirms it. |
| LLM judge use | Score whether the inference rationale uses the seeded evidence and handles ambiguity appropriately. |
| UI assertions where applicable | Dashboard shows proposed inference with evidence and approval/ignore controls; approved state updates without duplicate proposal. |
| Skip policy | These scenarios must use seeded deterministic signals and frozen time; missing live passive telemetry is not a valid skip for mock-mode proof. |

## Plan Review Checklist

Before marking an E2E/scenario plan ready, verify:

- Every scenario has the required fields above.
- Every write has target-discovery proof, approval proof when applicable, provider ledger proof, and cleanup.
- Every negative path proves absence of the unsafe side effect.
- Every UI scenario has browser-visible assertions, not only API assertions.
- Every semantic scenario has an LLM judge rubric with a named threshold.
- Every release-critical scenario states fail-on-skip behavior.
- Existing helper usage does not rely on substring-only action blobs when typed assertions can be used.
