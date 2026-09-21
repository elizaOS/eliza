# Local text acceptance — integrated candidate

Verified application source: `01d7cd65ec2` on `codex/group-channel-integration-20260920`.
Open http://127.0.0.1:5278/chat for this candidate. Ports 5248, 5258 and 5268 are different preserved checkpoints. Candidate API is 31402; state/database are isolated under the local evidence folder.

## Result and limits

Local text acceptance passed using fresh rendered checks, current deterministic tests, and explicitly reused baseline evidence. This is not production release acceptance, latest-develop integration, or a guarantee of sub-three-second replies. No production source changes were needed in this acceptance pass. The group/Discord integration remains the implementation at the source revision above.

Eleven paid user turns exercised one continuous conversation: greetings and all three navigation targets, exact note creation and edit, original-text recall, Calendar missing-time clarification with actual availability, clarified creation, conflict refusal, and scoped fixture cleanup. All functional outcomes passed. Reload restored the complete conversation and booked event. Delete receipts included the exact persisted edited note, and subsequent Notes state had zero notes; Calendar visibly had no events. Only the two owned fixtures were deleted. QA conversation/trajectories remain as evidence in this isolated state.

Calendar morning scheduling offered 9:00/9:15/9:30 AM without creating an event. After the user selected 9:15 for 15 minutes, exactly one event appeared. An overlapping 9:20 request identified that event and offered 9:30/9:45 instead of writing. The pending overlap request was explicitly withdrawn during cleanup.

## Measured foreground work

Backend trajectory durations, not browser click-to-visible measurements. Cached input is included within input, not additional tokens; telemetry is not a billing guarantee.

| Scenario | Backend time | Calls | Input tokens | Cached input |
|---|---:|---:|---:|---:|
| Greeting | 2.451s | 1 | 9,452 | 0 |
| Open Notes | 1.265s | 1 | 10,102 | 0 |
| Create exact note | 2.297s | 3 | 21,614 | 6,144 |
| Edit exact note | 2.204s | 3 | 22,969 | 9,216 |
| Recall original text | 0.887s | 1 | 10,468 | 7,168 |
| Go Home | 0.934s | 1 | 10,386 | 7,168 |
| Open Calendar | 1.384s | 1 | 10,558 | 0 |
| Morning availability / clarification | 4.971s | 5 | 45,850 | 12,288 |
| Create after clock time supplied | 3.520s | 4 | 28,083 | 9,216 |
| Reject conflicting booking | 2.982s | 4 | 29,330 | 14,336 |
| Cleanup note and event | 5.617s | 5 | 57,335 | 9,216 |

Navigation and recall used one handler call. Note writes used handler → planner/tool → completion. Calendar creation/conflict used four calls, including domain validation. Morning availability used five: handler 1.576s → planner .648s → evaluator .591s → planner .693s → evaluator .553s. The first evaluator unnecessarily returned CONTINUE; the next planner only proposed REPLY. Existing evaluator instructions already require finishing with the missing-input question. This is an observed model decision inefficiency, not an extra mandatory architectural stage. We retained the real trace and did not add a duplicate prompt rule, canned answer, forced finish, or weaken authorization to hide it. No repeated benchmark was run to obtain a faster number. Cleanup combined two mutations and took five calls.

Nine additional background-memory calls are recorded separately in the same eleven-turn evidence snapshot. They consume tokens even though they are not included in these foreground latency/call counts. This is not a one-call-total-cost claim for simple turns.

## Safeguards and evidence reuse

Fresh current-checkout deterministic checks: 183 passing tests across useChatSend, send/voice/newchat races, overlay ownership, and history hydration; eight passing acknowledgment tests. They cover stopping during deferred setup/hydration/recreation, ownership of pending UI state, acknowledgment routing and cancellation. These are controlled tests, not physical voice QA. Live acknowledgment rendering from the baseline remains prior evidence, not freshly timed in this pass.

Baseline scoped preference save/remove and reply-rule removal are reused from [CONSOLIDATION-QA.md](CONSOLIDATION-QA.md), rather than paying for repeats. The nine baseline fact records exactly equal the post-removal snapshot, with no additional page. Current integration diff does not alter Notes, Calendar, preference handlers, UI cancellation, or completion prompts. The direct-message discovery branch is preserved; changed core paths are covered by the integration suites and fresh app turns. Partial history-retention changes have their dedicated correction/dependency tests.

Current-source root verification already passed before this documentation-only acceptance checkpoint; see [GROUP-CHANNEL-INTEGRATION.md](GROUP-CHANNEL-INTEGRATION.md) for 594 core, 23 connector, six real-SQL tests and additional overlapping coverage. Those are scoped suites, not unique totals to add together. No source changed since that gate.

Startup briefly showed More apps unavailable; catalog and installed-app endpoints subsequently returned 200 and the warning disappeared on return Home. No persistent failure was reproduced. Historical build-time request delays remain causally unproven. Use a clean loaded UI for rehearsal rather than hot-updating hooks during a turn.

## Evidence and release boundary

Local evidence: `/Users/nubs/Documents/ChatGPT/test/eliza-group-channel-integration-20260920/app-qa/` (`ACCEPTANCE.md`, `TEXT-QA.md`, runtime traces and test logs). Raw traces/configuration are deliberately not committed. Existing group verification log is in the parent evidence directory.

Voice/native-device checks, actual Discord sends, deployment and protected-branch merges remain deferred. Consistent under-three-second completion remains unachieved. No claim of latest remote develop or all uncommitted remote work is made. This checkpoint is local and has not been pushed. Review these limitations before treating it as a launch candidate.
