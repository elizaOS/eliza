# Plan: Close Executive-Assistant Capability Gaps

Status: Draft for review
Date: 2026-04-17
Owner: TBD
Related: [PRD](../prd-lifeops-executive-assistant.md), [scenario matrix](../plan-lifeops-executive-assistant-scenario-matrix.md)

---

## 1. Goal

Make LifeOps good enough to be benchmarked as a real executive assistant against the 22 transcript-derived scenarios and the 15-connector certification catalog — with **no heuristics, no larp, no mocks standing in for real connectors**.

Three things have to be true when this is done:

1. **Data is there when it's needed.** The agent can search every channel, every memory, every user/room/world on demand and bring the result into the current turn.
2. **Reach is universal.** Every connector in the catalog is set up, connected, auditable, and able to send/receive/search. Identity is unified across channels.
3. **Every action is LLM-extracted.** No keyword routing, no English regex, no score formulas. Multilingual users work the same as English users.
4. **Every claim is tested live.** Real LLM, real DB (PGlite), real connectors with real credentials, end-to-end, in CI. Failures are loud.

---

## 2. Current Ground Truth

### 2.1 What's real (keep)

- `getMemories` / `searchMemories` support roomId/worldId/entityId/embedding filters. `eliza/packages/typescript/src/types/database.ts:825`.
- `SEARCH_CONVERSATIONS` action with semantic search and cross-room aggregation. `eliza/packages/agent/src/actions/search-conversations.ts:52`.
- `relevant-conversations` provider. `eliza/packages/agent/src/providers/relevant-conversations.ts:21`.
- Clipboard plugin (CLIPBOARD_WRITE/SEARCH/READ/APPEND/DELETE). `eliza/packages/typescript/src/features/advanced-capabilities/clipboard/index.ts`.
- `life-smoke.integration.test.ts` boots a real AgentRuntime on PGlite. `apps/app-lifeops/test/life-smoke.integration.test.ts:44`.
- 37 `.live.e2e.test.ts` suites exist, gated on credentials (`credentialDependentE2EPaths` in `test/vitest/e2e.config.ts:41`).
- Scenario runner at `scripts/lifeops-scenario-runner.ts` executes scenarios against a live HTTP runtime with LLM judging.
- No-heuristics contract at `apps/app-lifeops/test/lifeops-no-heuristics.contract.test.ts` guards the cleaned-up files.

### 2.2 What's fake or missing

See §3 for gap-by-gap breakdown.

---

## 3. Gap Inventory

### 3.1 Connectors

15 connectors declared by PRD. Audit matrix:

| Connector | In | Out | Search | Ident | Attach | Delivery | Status |
|---|---|---|---|---|---|---|---|
| Gmail | ✓ | ✓ | ✓ | ✓ | ✓ | partial | **Wired** |
| Google Calendar | ✓ | ✓ | ✓ | ✓ | — | — | **Wired** |
| Google Drive/Docs/Sheets | ✗ | ✗ | ✗ | — | — | — | **Missing** |
| Discord (browser) | ✓ | ✓ | ✗ | ✓ | ✓ | stub | **Partial** |
| Telegram (MTProto) | ✓ | ✓ | ✗ | ✓ | partial | ✗ | **Partial** |
| Signal | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | **Stub** |
| iMessage | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | **Partial** |
| WhatsApp | webhook only | ✓ | ✗ | ✓ | ✗ | ✗ | **Stub** |
| Twilio SMS | — | ✓ | ✗ | — | ✗ | ✓ | **Wired (outbound)** |
| Twilio Voice | — | ✓ | ✗ | — | ✗ | ✓ | **Wired (outbound)** |
| X DM | read ✓ | post ✓ | ✗ | ✓ | ✗ | ✗ | **DM missing, feed only** |
| Calendly | ✓ | ✓ | ✓ | ✓ | — | — | **Wired** |
| Browser Portal | ✓ probe | ✓ DOM | ✗ | ✓ | — | — | **Partial** |
| Notifications (push) | — | in-app only | ✗ | — | — | — | **Missing** |
| Travel Booking | ✗ | ✗ | ✗ | — | — | — | **Missing** |

Cross-channel send registry (`apps/app-lifeops/src/actions/cross-channel-send.ts`) covers 8 channels; **missing: calendly, drive, notifications, travel, x-dm.**

**No unified cross-channel search action exists anywhere.** Each fetch is siloed per connector.

### 3.2 Cross-channel search & "bring context"

Primitives exist (`searchMemories`, `getMemories`, `SEARCH_CONVERSATIONS`, clipboard) but there is no LifeOps-level action that:

- Searches Gmail + Telegram + Discord + iMessage + WhatsApp + Signal + X DM simultaneously
- Deduplicates by canonical identity
- Returns threaded context with citations back to source room + timestamp
- Writes results to clipboard in a shape the agent can consume in the next turn

`apps/app-lifeops/src/providers/lifeops.ts` is owner-context only, not general search.

### 3.3 Cross-platform identity

**Missing entirely.** The runtime has `entityId` per room and `components` for attributes, but there is no canonical entity — "Jill on Discord = Jill on Telegram = jill@x.com" cannot be expressed.

Memory note says this is active work. Need to find what's in flight and either coordinate or drive it.

### 3.4 Heuristic leftovers (kills multilingual)

Cleaned: `life.ts`, `inbox.ts`, `reflection.ts`, `triage-classifier.ts` (classifier), `google-gmail.ts`, `cross-channel-send.ts`.

Still dirty:
- `apps/app-lifeops/src/actions/calendar.ts` — regex subaction routing (L895-939), English keyword scoring (L709-735), English month/weekday parsing (L1023-1089), personal-event regex (L1257, L1336). **BREAKS MULTILINGUAL.**
- `apps/app-lifeops/src/actions/scheduling.ts` — English regex subaction routing (L652-659), English weekday abbrev in tz formatter (L100). **BREAKS MULTILINGUAL.**
- `apps/app-lifeops/src/actions/relationships.ts` — 7+ regex subaction patterns (L66-84). **BREAKS MULTILINGUAL.**
- `apps/app-lifeops/src/actions/health.ts` — English metric regex (L50-68). **BREAKS MULTILINGUAL.**
- `apps/app-lifeops/src/actions/life.ts` — time-phrase regex at L1181-1195 (goal-update parsing only; STYLE).
- `apps/app-lifeops/src/inbox/triage-classifier.ts` L170 — fragile `match(/\[[\s\S]*\]/)` JSON extraction (FRAGILITY).
- `inbox.ts` L183 — hardcoded subaction enum check (STYLE — OK since the enum is internal, not user-facing text).

### 3.5 Background jobs vs chat parity

PRD lines 418-433 declare 11 background jobs (brief builder, follow-up watchdog, decision nudger, meeting reminder, travel conflict detector, asset sweeper, draft aging sweeper, stuck-agent escalator, etc.). PRD demands they flow through the same extraction/planning pipeline as chat. **Not verified — no test asserts pipeline parity.**

### 3.6 Approval/draft model completeness

Contract test enforces cross-channel send goes through dispatcher registry, but approval gating for:
- Bookings (Calendly, travel)
- Portal uploads
- Browser automation
- Cross-channel escalations

...is **not covered by any scenario assertion that inspects the approval queue state machine.** Scenarios declare "approval-aware" integration labels but don't verify the queue.

### 3.7 E2E test liveness

Breakdown:

| Layer | Status | Notes |
|---|---|---|
| Unit | **Real code, no runtime** | Excludes integration/e2e |
| Integration (`.integration.test.ts`) | **Real runtime + real PGlite, mock LLM + mock connectors** | Good for logic, blind to behavior |
| Contract (`lifeops-*-contract.test.ts`) | **SOURCE SCANNING ONLY** | Does not execute the agent |
| Scenario files (`test/scenarios/**/*.scenario.ts`) | **Real LLM + real runtime, text-pattern assertions** | Assertions are shallow |
| `.live.e2e.test.ts` (37 suites) | **Real LLM + real connectors**, credential-gated | Silently skip when creds absent |
| `.real.e2e.test.ts` | **Real agents against test networks** | Specialized |
| Desktop/UI e2e | **None** | Manual only |
| Benchmark harness | `packages/benchmarks/app-eval/` exists | Not wired to EA scenarios |

Key risks:
- **Silent skip on missing credentials** — `credentialDependentE2EPaths` excluded from baseline PR lane
- **Native modules disabled in CI** (`install-native-deps: false`) — some connectors can't actually run
- **Contract tests are not behavior tests** — they're lint rules dressed up as tests
- **No agent-vs-scenario scoring gate** — scenario runner produces LLM judge scores, no CI threshold

---

## 4. Proposed Work Streams

Eight parallel streams. Each has a clear scope and a verifiable exit.

### WS1. Cross-channel search action + provider

**New:** `SEARCH_ACROSS_CHANNELS` action and `cross-channel-context` provider.

- Input: free-form query, optional (person, timeWindow, channels, worldId).
- LLM extraction for query shape (no regex).
- Backend: fan out across enabled connectors in parallel, merge by canonical identity (WS3), rank by embedding + time, return threaded citations.
- Emit clipboard-ready payload that future turns can `CLIPBOARD_SEARCH` against.
- Provider injects top-N matches into context when the planner asks for prior signal on a named person/topic.

Exit: scenario `ea.inbox.daily-brief-cross-channel` asserts the brief includes at least one item per enabled channel the owner used in the last 24h, verified against a real PGlite with seeded messages across 3+ channels.

### WS2. Connector gap closure

Priority order (PRD P0 pressure + unblock other streams):

1. **Google Drive / Docs / Sheets** — read + write + search. Wires to docs scenarios.
2. **Signal inbound** — receive, not just send.
3. **WhatsApp sync** — periodic fetch, not just webhook parse.
4. **X DM** — inbound + outbound DM parity with feed code.
5. **Notifications (mobile push)** — real APNs/FCM target for owner.
6. **Travel booking** — at minimum one flight adapter and one hotel adapter (Amadeus or Duffel for flights, Hotelbeds for hotels, or similar).
7. **Discord search + read receipts**, **Telegram search + receipts**, **iMessage receipts** — bring parity with Gmail.

Every connector must add itself to the `CHANNEL_DISPATCHERS` registry and the certification catalog entry must flip from `missing` → `wired`.

Exit: connector certification contract test `lifeops-connector-certification.contract.test.ts` enforces a live liveness probe per connector, not just catalog shape.

### WS3. Canonical identity resolver

Coordinate with the active cross-platform identity workstream (memory flag). If not already in design:

- New component type `canonical-identity` on entities, storing `{platform, handle, verifiedAt, source}` tuples.
- New action `LINK_IDENTITY` — LLM-extracted from user confirmation ("yes that's Jill's telegram").
- New runtime API on the adapter: `resolveCanonical(entityRefOrHandle) → canonicalEntityId`.
- `getMemories` / `searchMemories` extended to accept `canonicalEntityId` and fan out to all participant rooms.
- Dossier service updated to dedupe by canonical id.

Exit: integration test seeds a user with Discord + Telegram + Gmail IDs, asks "what did Jill say last week," returns merged result across all three.

### WS4. LLM planner sweep — kill remaining heuristics

File-by-file, in this order:

1. `calendar.ts` — replace regex subaction routing + English scoring + personal-event keyword regex with the same `resolveSubactionPlan()` pattern used in `inbox.ts`. English month/weekday parsing → delegate to LLM extraction of structured `{date, time, tz}` fields validated against `Intl` output.
2. `scheduling.ts` — replace L652-659 regex with LLM subaction planner. Fix `dayOfWeekInTz()` to use a tz-safe non-English path.
3. `relationships.ts` — replace L66-84 regex with LLM subaction planner.
4. `health.ts` — replace L50-68 metric detection with LLM extraction of `{metric, timeRange}` against a typed enum.
5. `life.ts` L1181-1195 — replace time-phrase regex with LLM extraction when goal update is detected.
6. `triage-classifier.ts` L170 — replace fragile regex-based JSON extraction with a proper JSON parse of model output (request `response_format: json` or schema-constrained).

Extend `lifeops-no-heuristics.contract.test.ts` to guard each of these, so regressions fail CI.

Exit: multilingual smoke test — feed Spanish + Japanese variants of 10 core commands through the LIFE action, assert correct subaction selection.

### WS5. Background job pipeline parity

- Every background job resolves through the same LLM planner entry point as chat (`resolveSubactionPlan` or equivalent).
- Remove any bespoke job-specific routing.
- Add a contract test asserting every job in the PRD list invokes the planner.
- Each job must emit an approval queue entry for sensitive actions (not just execute).

Exit: scenario `ea.followup.bump-unanswered-decision` verifies the decision nudger runs through planner and queues approvals, not direct sends.

### WS6. Approval queue as first-class state

- Formalize the approval queue: a typed table (`approval_requests`) with state machine (pending → approved → executing → done | rejected | expired).
- Every sensitive action writes a request; only the queue drains it after user consent.
- Add UI hooks so the approval view is testable.
- Scenarios assert queue entries and transitions, not just final output text.

Exit: scenarios `ea.travel.book-after-approval`, `ea.docs.portal-upload-from-chat`, `ea.push.cancellation-fee-warning` assert an approval was created, gated send happened only after explicit confirmation, and no side effect occurred on reject.

### WS7. Live E2E + benchmark harness

- Flip `install-native-deps: true` in CI (with timing budget), or split into a native-deps job that always runs.
- Fail the build if any credential-gated suite is skipped without an explicit `SKIP_REASON` env var on the run.
- Promote `lifeops-*-contract.test.ts` to actually boot the agent and run a smoke turn, not just scan source.
- Wire the scenario runner into `bun run test:e2e:live` in CI with real credentials (from CI secrets) and an LLM-judge pass threshold.
- Extend `packages/benchmarks/app-eval/` to include all 22 executive-assistant scenarios and all 15 connector certification scenarios, produce a weekly benchmark report with deltas.
- Add a desktop e2e lane using Electrobun + Playwright or Electron equivalent — at minimum, boot the app, send a message, get a reply.

Exit: CI shows live green for scenarios, connector certification, and a weekly benchmark baseline is published.

### WS8. Scenario assertions — beyond text patterns

Current scenario assertions check `responseIncludesAny` regex patterns. This is LLM-translation-brittle and doesn't prove correctness.

- Migrate scenarios to assert on **action invocation shape** (already started via `action-assertions.ts`) plus **side effects** (approval queue entries, memory writes, connector dispatcher calls) plus **judge rubric scores** from the LLM judge.
- Every scenario gets at least: one action shape assertion, one side-effect assertion, one rubric score ≥ threshold.

Exit: no scenario passes solely on text pattern matching.

---

## 5. Dependencies & Sequencing

```
WS3 (identity)  ──────┐
                       ├──► WS1 (cross-channel search)  ──► WS8 (scenario depth)
WS2 (connectors) ─────┘                                  │
                                                           │
WS4 (heuristics) ──► WS5 (bg parity) ──► WS6 (approvals) ─┤
                                                           │
                         WS7 (live CI + benchmark) ◄──────┘
```

WS3 + WS2 unblock WS1. WS1 + WS6 unblock WS8. WS7 is continuous and lights up as streams land.

Sequencing suggestion:
- **Week 1:** WS4 sweep (low risk, high confidence — direct follow-on to current patch). WS7 stream lights up (flip flags, fail-on-skip).
- **Week 2:** WS3 identity + WS2 top 3 connectors (Drive, Signal, WhatsApp sync).
- **Week 3:** WS1 cross-channel search + WS6 approval queue.
- **Week 4:** WS5 bg parity, WS2 remaining connectors, WS8 scenario migration, WS7 benchmark publish.

---

## 6. Risks & Unknowns

- **Identity linking is already in flight** per memory. Need to discover current state before duplicating work. Risk: stepping on in-progress design.
- **Travel booking** — real flight/hotel APIs require commercial agreements (Amadeus, Duffel, Hotelbeds) or stack on top of aggregators. May need a phased "read-only search first, transact later" approach.
- **Notifications / push** — requires APNs and FCM credentials and a relay service. Not trivial infra.
- **Native modules in CI** — flipping `install-native-deps: true` will slow CI; may need a dedicated runner image.
- **Silent credential skips** — flipping fail-on-skip will immediately red-light CI until creds are provisioned. Needs a credential inventory first.
- **LLM judge thresholds** — picking pass/fail thresholds for scenario scoring is subjective; risk of either too-easy (useless) or too-brittle (flaky).
- **Browser-portal automation at scale** — DOM eval is fragile; portal changes silently break the scenario.
- **Approval queue UX** — a state machine without UI is useless; WS6 implicitly requires UI work in app-core dashboard.

---

## 7. Clarifying Questions

Before I start:

1. **Identity linking** — where does the active work live? Branch, PR, design doc? I should plug into it rather than build parallel.
2. **Travel booking** — is there a preferred adapter (Amadeus/Duffel/etc.), or do we start with browser-portal automation of existing booking sites as the v1?
3. **Notifications** — is an owned relay service in scope, or do we use an existing push-relay (e.g., Ntfy, Pushover, or Eliza Cloud's push)?
4. **LLM judge thresholds** — is "all scenarios pass with judge score ≥ 0.8" the bar, or something else? Per-scenario rubric-tuned thresholds?
5. **CI budget** — is it acceptable to lengthen baseline PR CI by ~10 min to run native-dep builds + a small live-credential smoke? Or should live stay as a nightly?
6. **Scope of this plan** — does it include the desktop/UI e2e lane, or is that a separate track?
7. **Heuristic cleanup** — `calendar.ts` is the next file per the earlier summary. Do you want me to attack WS4 immediately in a separate branch while the rest of the plan is reviewed, or wait for full approval?
8. **Benchmark cadence** — weekly, nightly, or per-PR?

---

## 8. Out of Scope

- New scenario authoring beyond the existing 22 + 15 (unless a gap is exposed).
- Architectural rework of the elizaOS runtime (plugin-sql, core memory APIs) — we extend, not rewrite.
- UI component library overhaul — only approval queue view gets added in WS6.
- Marketing / docs site.

---

## 9. Definition of Done

- All 15 connectors: inbound, outbound, search, identity, attachments, delivery status — either wired with live probe, or explicitly de-scoped in writing.
- Unified cross-channel search action + provider, used by daily brief scenarios.
- Canonical identity resolver in runtime, used by dossier and search.
- No heuristic routing in any action file. `lifeops-no-heuristics.contract.test.ts` covers every action.
- Every background job goes through the planner; asserted by contract test.
- Approval queue is typed, persisted, UI-surfaced, and asserted by sensitive-action scenarios.
- CI runs live-LLM + live-DB + live-connector suites with fail-on-skip and an LLM-judge threshold.
- Weekly benchmark report published covering all 37 catalog scenarios.
- No contract test passes by scanning source alone — every contract actually runs the agent.
- No scenario passes solely on text-pattern regex.
