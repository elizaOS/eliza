<!-- Saved September 19 before isolated peer integration. Live board remains in the external task artifact directory. -->

# Eliza: saved pre-integration acceptance snapshot

Updated September 18, 2026. **Start here for current status.** This is the maintained checklist; older plans and scenario logs are history/evidence, not competing task lists.

## Right now

- **Ready for your text rehearsal:** http://127.0.0.1:5248/chat (same continuous chat).
- Current task: user rehearsal and triage of anything that fails. No new feature work or paid automated test sweep is running.
- Local branch: `ganttnubs`, checkout `/Users/nubs/Git/eliza-core-latency-cleanup-20260917`.
- Accepted code: `f0c5bddfe3d1c8487a3a51d19d6b9cd3c01a9e38`.
- Rollback tag: `codex/ganttnubs-calendar-contracts-20260918`. Local only; no push/merge/deployment.
- API: `http://127.0.0.1:31372`; readiness/database checked healthy when this checklist was created. This is a point-in-time check, not monitoring.
- Peer app `5228` is different code; `5199` may also differ. Test **5248** for this checklist.
- Voice remains deferred. Source tags preserve code, not chat, Notes or Calendar data.

## Who did what — current coordination

- **This original task, “Compare August 7 Eliza demo”:** current point of contact. Owns the accepted `ganttnubs` candidate at `f0c5bddfe3d` and app **5248**. Continue reporting rehearsal results here.
- **“Finish Eliza text latency and Calendar…”:** the continuation task finished at `484d1e9eec1` and is idle. Git ancestry confirms its checkpoint is already included in our current candidate. The original task then independently checked it and added the latest repairs. There is nothing to merge from that continuation checkpoint.
- **Separate `nubsDONTDELETEpls` branch work:** its task is idle at a documented stopping point, with published `e59818bf174` and a separate runtime formerly tested on **5228**. Its history/context improvements are not integrated into `ganttnubs`. Its handoff lists remaining latency/prompt/recall tradeoffs; idle does not mean the entire product is finished.

All three statuses were checked after the user asked for clarification. “Done” currently means the bounded local text repair/checkpoint, not every branch merged or all product work complete. Next action: use app **5248**, test normally, and report issues in this original task. No need to coordinate other tasks during the rehearsal.

## Status meanings

**DONE** = evidence exists for the stated scope. **NOW** = current next step. **OPEN** = remains to do. **DEFERRED** = deliberately outside this text pass. A passing unit test is not a user/browser pass; a local pass is not a release pass.

## Work board

| ID | Status | Work | Acceptance / evidence |
|---|---|---|---|
| T01 | DONE, bounded | Compare August baseline with newer app; preserve useful changes | Historical comparison documented; exact filming commit unproven. No blind rollback. |
| T02 | DONE, tested samples | Keep greetings/navigation simple | Real navigation uses one handler call and opens the requested view. No mandatory extra planner. |
| T03 | DONE, tested samples | Notes create/read/exact edit and date filtering | Stored text, punctuation/spacing and requested field changes verified; corrections recalled; date filters tested. |
| T04 | DONE, tested samples | Calendar missing time, conflicts and accepted moves | Missing clock asks; conflict prevents unauthorized booking; selected move preserves record/duration and rechecks availability. |
| T05 | DONE, latest patch | Calendar selector and time-window repairs | Explicit delete targets; conflicting selectors reject; source query separated from destination; invalid windows reject; local clocks converted in code; proposal pauses for selection. |
| T06 | DONE, bounded | Acknowledgment and final-reply delivery | Early acknowledgment reuses handler call; transient, no extra acknowledgment model call; final reply grounded in tool results. Existing tests/browser evidence, not universal network-failure acceptance. |
| T07 | DONE, bounded | Preserve continuous chat and context | No chat reset, arbitrary truncation or preference hack. Exact earlier/current note recall tested. This does not certify every long-term memory path. |
| T08 | DONE | Verify and checkpoint | Root 373/373 plus audits; Calendar 1,014 pass/4 skips; final PA files 57 pass; core routing 457 pass. Final browser checks and source fingerprint saved. |
| T09 | DONE | Remove this pass's fixtures | Exact comparison preserved 41 original notes and 3 original Calendar records in Sep18–20 window. Older records, including prior QA notes, intentionally preserved. |
| T10 | NOW | Your text rehearsal | Complete or flag the scenarios below. Record actual prompt and observed issue, not just “it felt bad.” No requirement to run every case before trying the app normally. |
| T11 | OPEN, triggered by evidence | Fix any reproducible rehearsal failure | Trace the actual run; smallest justified fix; owning regression test; relevant browser recheck; checkpoint. Failed runs remain recorded. |
| T12 | OPEN | Consistent approximately-three-second latency | Measure acknowledgment/first visible/final separately; count all foreground calls, inputs and cache reads. Final samples below are not percentile guarantees. Do not remove validation/history just to hit a number. |
| T13 | OPEN, targeted only | Broader memory/preferences acceptance | Current-turn note correction recall passed. Long-range exact quotation, source ownership, personal preference removal scope and retention need targeted current-branch evidence before broader claims. Reuse existing trajectories first. |
| T14 | DONE review; DEFERRED integration | Peer branch e59818bf174 | Handoff and 20 overlapping paths reviewed. Later use isolated checkout; compare source ownership, recovery, permissions, corrections, calls and cached inputs before integrating selected work. |
| T15 | DEFERRED | Voice / Cartesia / animation | Separate explicit voice acceptance after text rehearsal. No microphone/audio tests now. |
| T16 | DEFERRED | Develop consolidation, external-provider/device and release QA | Separate integration/acceptance scope after stable text checkpoint. Local pass does not authorize merge/deployment. |
| T17 | DEFERRED | Broader PRD/product scope | Reconcile meeting product backlog after text acceptance. Acknowledgments already implemented; broader Browser/attachments/reminders/messaging work is not silently included in this pass. |

## Your rehearsal: acceptance checklist

Use unique names such as `My rehearsal 2249`; change the suffix for another run. Use a future date and an explicit timezone for the controlled Calendar checks. The example dates below are for a September 18 rehearsal; replace them if testing later. These prompts are examples, not special phrases implemented in code.

| Check | Example / action | Pass means | Your result |
|---|---|---|---|
| U01 Navigation | “Hi”, then “Open Notes”, then “Go home” | Natural short greeting; actual requested view opens; no stuck Thinking or unnecessary planning | NOT RUN |
| U02 Exact note | “Create a note titled My rehearsal 2249. Use exactly this body: Paper cranes fly.” | One saved note with the requested title/body; no claimed write without persistence | NOT RUN |
| U03 Edit + recall | “In that note replace only cranes with kites.” Then “What word did I originally use, and what does the note say now?” | Original cranes, current kites; unrelated text/records unchanged; recall uses actual context/source | NOT RUN |
| U04 Explicit Calendar create | “Create a temporary local event titled My rehearsal 2249 on Tuesday September 22, 2026 at 10 AM America/Los_Angeles for 15 minutes, only if free. No guests.” | Correct date/local time/duration, one event; if occupied, reports conflict and does not book it | NOT RUN |
| U05 Conflict | If U04 created at 10 AM: request My overlap 2249 at 10:05 AM that day for 15 minutes, only if free; ask what blocks it; do not book an alternative | Names/time of authorized conflicting event, no overlap write, proposed alternatives backed by availability | NOT RUN |
| U06 Morning proposal | “Cancel the overlap request. Find three available morning times Wednesday September 23, 2026 in America/Los_Angeles for moving My rehearsal 2249. Keep its duration. Don't move it yet.” | Correct day/timezone and existing event, checked choices, no guessed booking, no premature move | NOT RUN |
| U07 Accept one | “Use the second option, keeping its duration.” | Moves the same event exactly once to the accepted slot; checks conflicts again; no duplicate/replacement event | NOT RUN |
| U08 Read back | Open Calendar and Notes; ask for saved details if needed | Visible saved state matches the reply; date/time/body are correct | NOT RUN |
| U09 Cleanup | Cancel remaining test intentions; delete only your uniquely named temporary note/event(s) | Only named fixtures removed; no unrelated records changed; partial failure reported honestly | NOT RUN |
| U10 Delivery, throughout | Watch acknowledgment, Thinking and final reply | Acknowledgment is not a premature success claim; one authoritative final reply, no repeated rewriting or stuck spinner | NOT RUN |

**Known interpretation limit:** ambiguous unquoted note content versus app instructions is not guaranteed (“Stay here” could be intended literal content). Exact-body syntax makes the controlled test unambiguous; ordinary natural-language ambiguity remains a separate acceptance concern. Do not solve it with a test-phrase keyword rule.

## Speed and model-call reference

Latest final-source samples; input totals sum across calls. Cache-read tokens are included in input totals.

| Scenario | Foreground calls | Final trajectory time | Input / cached |
|---|---:|---:|---:|
| Open Notes | 1 | 1.334s | 9,612 / 7,168 |
| Fresh available-time proposal | 3 | 3.162s | 28,981 / 13,312 |
| Delete temporary event | 3 | 3.413s | 29,746 / 10,240 |
| Ask for clock after prior availability | 1 | 1.570s | 9,838 / 6,144 |

Typical architecture: **handler → planner/tools → final evaluator**. Simple reply/navigation can finish in the handler. A Calendar write may add a domain extraction/validation call. Retries, unresolved work and source recovery can add calls. Background memory calls are separate from these foreground totals. Acknowledgments improve perceived wait; they do not reduce total completion time.

Performance is **OPEN**, not a correctness failure solely because a correct turn takes 3.2s. A 7-second run must be attributed from its trace (calls, provider time/retries, prompt size/cache, tools/host and delivery), rather than blamed on Wi-Fi without evidence. Minimize paid repetition; inspect the existing run first.

## If something fails

Add one row here; Codex owns trajectory/debug lookup. You only need the exact prompt or approximate time and what looked wrong. Do not repeat a potentially successful write merely to obtain a nicer reply; verify the saved record first.

| ID | Prompt/time | Expected vs actual | Trace / saved-state evidence | Status / fix / retest |
|---|---|---|---|---|
| — | No new user-rehearsal report yet | — | — | — |

## Exit criteria and sequence

1. **Now:** your text rehearsal; maintain this checklist and inspect only reported/observed failures.
2. **Text demo accepted:** core chosen scenarios correct, no unauthorized/duplicate writes, no stuck or changing final replies; measured speed and remaining limits disclosed; user accepts the experience.
3. **If failures:** reproduce from traces, fix the relevant boundary, run owning checks and affected visible flow, preserve fixture hygiene, commit/tag. Do not silently broaden into new features.
4. **Then:** bounded remaining latency/context work and isolated peer integration assessment. Preserve ownership, permissions, exact text, corrections and recovery; compare against this saved checkpoint.
5. **Last/separate:** voice, wider PRD/product tasks and develop/release consolidation.

Keep only this board authoritative for active status. Update it when a task starts, evidence arrives, a criterion fails/passes, or a checkpoint changes. Link evidence instead of duplicating whole logs. Mark user acceptance only after the user actually tests/accepts it. Do not open another competing plan or mark the entire product perfect from a few samples.

## Evidence and background

- [Short current-state explanation](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/CURRENT-STATE-GUIDE.md)
- [Independent QA, including failed runs](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/OWNER-QA-20260918.md)
- [Repository scenario ledger](/Users/nubs/Git/eliza-core-latency-cleanup-20260917/GANTTNUBS-SCENARIO-RESULTS.md)
- [Final calls/input/cache ledger](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/candidate-runtime/owner-accepted-final-ledger.json)
- [Final persistence comparison](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/candidate-runtime/owner-accepted-final-persistence.json)
- [Final repository verification](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/candidate-runtime/latency-audit/owner-accepted-final-verify.log)
- [Peer overlap review](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/PEER-INTEGRATION-REVIEW-20260918.json)
- [Original August comparison plan](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/CLEANUP-PLAN.md)
- [Completed finish-pass checklist](/Users/nubs/Documents/ChatGPT/test/eliza-aug07-comparison-20260917/ACTIVE-FINISH-GOAL.md)
