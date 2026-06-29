# #9970 — personal-assistant scenarios assert outcomes, not routing

The core complaint of #9970: PA scenarios overwhelmingly assert **routing**
(`plannerIncludesAll` / `selectedAction`) rather than the **outcome** the action
produced. Verified at the start of this change:

```
$ grep -rl "plannerIncludes" .../test/scenarios | wc -l   # routing-only: 142
$ grep -rl "assertResponse|assertApiBody|assertEffect" ... | wc -l   # outcome:   4
```

This change adds **5 grounded, outcome-asserting scenarios** that seed real
state and assert the *result* via the persisted API / repository, covering the
acceptance-named capabilities (calendar-conflict, email-reply, inbox-triage)
plus approval-resolution and multi-channel notification delivery.

## The 5 new scenarios (each asserts a real outcome)

| Scenario | Seeds | Asserts the OUTCOME (not routing) | Grounded in |
| --- | --- | --- | --- |
| `calendar-conflict-resolve-outcome` | two overlapping `once` commitments (budget review now+120m, dentist now+150m) | after reschedule, a `GET` proves the dentist's `cadence.dueAt` is now >240m out (clear of the now+180m anchor end) **and** the anchor slot is unchanged → the *right* item moved and the overlap is gone; `definitionCountDelta` for both; `memoryWriteOccurred` on `messages` | `lifeops-routes.ts` POST/PUT/GET `/api/lifeops/definitions` (createDefinition/updateDefinition re-derives occurrences) |
| `email-reply-draft-outcome` | a gmail inbox fixture (`sarah-product-brief.eml`) | `draftExists{channel:gmail}` + `gmailDraftCreated` + `gmailActionArguments{subaction:draft_reply}` — a real draft was produced with the right fields, and **not sent** | `seeds.ts` `seedGmailInbox`, MESSAGE/`draft_reply` subaction |
| `inbox-triage-classification-outcome` | cross-channel inbox messages (a production-outage DM + an automated newsletter) | a `custom` predicate reads back `InboxRepository.getBySourceMessageId` and asserts the **actual** classification (outage DM ⇒ `urgent`; newsletter ⇒ low-priority) — not merely that INBOX was selected | `InboxService.triage` → `classifyMessages` (`useModel`, purpose `inbox_triage`) → `InboxRepository.storeTriage` |
| `approval-queue-resolve-outcome` | a sensitive `sign_document` action that enqueues a pending approval | `custom` predicates assert a real PENDING row was enqueued, then a RESOLVE_REQUEST drove it to approved/executed **and the gated side effect actually ran**; a companion path asserts **no side effect on reject** | live approval queue via `PERSONAL_ASSISTANT(sign_document)` / `RESOLVE_REQUEST` action results |
| `notification-delivery-multichannel-outcome` | a reminder with a multi-step `reminderPlan` across in_app/discord/telegram + channel policies | `assertResponse` on `/reminders/process` + `/reminders/inspection` proves the plan fanned out and **delivered on each channel** (`attempts[]` with `delivered`), not just that a reminder action was selected | `lifeops-routes.ts` `/api/lifeops/channel-policies`, `/reminders/process`, `/reminders/inspection` |

Every scenario was authored by reading the **real** route handlers / services /
seed code and citing them (no guessed endpoints or shapes). Where the obvious
path was a dead end in the headless scenario runtime, the scenario documents
*why* and uses the persistent path instead — e.g. calendar uses the PGLite-backed
LifeOps **definition** store rather than `/api/lifeops/calendar/events` because
the scenario runtime has no Google grant / Apple Calendar bridge, so calendar
writes would not persist.

## Validation run on this branch

```
$ bun packages/scenario-runner/src/cli.ts list plugins/plugin-personal-assistant/test/scenarios
exit: 0
  ✓ calendar-conflict-resolve-outcome            (parses, schema-valid)
  ✓ email-reply-draft-outcome
  ✓ inbox-triage-classification-outcome
  ✓ approval-queue-resolve-outcome
  ✓ notification-delivery-multichannel-outcome
```

All 5 load and pass the scenario schema/corpus shape check, using only valid
outcome `finalChecks` (`definitionCountDelta`, `memoryWriteOccurred`,
`draftExists`, `gmailDraftCreated`, `gmailActionArguments`, `custom`,
`connectorDispatchOccurred`/`messageDelivered`) + `assertResponse` predicates.

## Live-LLM trajectory — BLOCKED in this environment (not faked)

These are `lane: "live-only"` and the **required** real-LLM trajectory evidence
(per `PR_EVIDENCE.md`) is captured by running them against a live model:

```bash
# Together (OpenAI-compatible) live model:
OPENAI_API_KEY=$XAI_API_KEY \
OPENAI_BASE_URL=https://api.together.xyz/v1 \
OPENAI_LARGE_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo \
OPENAI_SMALL_MODEL=Qwen/Qwen2.5-7B-Instruct-Turbo \
ANTHROPIC_API_KEY= \
bun packages/scenario-runner/src/cli.ts run plugins/plugin-personal-assistant/test/scenarios \
  --scenario calendar-conflict-resolve-outcome,inbox-triage-classification-outcome,email-reply-draft-outcome \
  --report .github/issue-evidence/9970-<scenario>-report.json \
  --export-native .github/issue-evidence/9970-<scenario>.jsonl --lane live-only
```

It was **not** run in this session because the build host is at **100% disk (≈2
GiB free) shared across 8 concurrent agent worktrees**, and this worktree's
`dist/` is symlinked from a different base — so a live boot would either risk a
system-wide `ENOSPC` that could break the concurrent swarm's writes, or test
**stale** PA code rather than develop's. Running against stale code would itself
be larp. The honest state: the scenarios are authored, grounded, and
schema-validated; the live trajectory must be captured on a host with disk
headroom and a fresh PA build (the command above is turnkey).
