# Group-channel integration acceptance

Branch: `codex/group-channel-integration-20260920`
Base: `9741f3a8b77` (verified consolidation checkpoint)
Discord checkpoint: `78b2b379b22`

The demo processes and original worktrees remain unchanged. This branch is a local integration candidate, not a deployment or an accepted production release.

## What changed

1. **One saved Discord reply.** Adapted `5c69040b85a`. Chunked delivery keeps the full reply once and attaches all platform message IDs. SQL ignores conflicting inserts, so the connector reads the stored winner before attaching delivery facts. Agent, author and room must match; a failed update is reported. No Discord network traffic was used for verification.
2. **Group context discovery.** Adapted `8657e653dde` and `e569f87b1ff`. Text groups use existing authorized reference reads rather than eager full catalogs. Direct-voice behavior is preserved. Group engagement, silence, acknowledgment and direct-chat ignore-review rules remain distinct. An initial test caught the extra ignore-review call; the direct-only guard fixes it.
3. **Incomplete classification preserves evidence.** Adapted `a3536706bf3`. Omitted sources remain visible and return in the next review. Existing correction/cancellation dependency closure remains. Explicit incomplete outputs, stale bindings, duplicate/unknown IDs and invalid dependency groups still reject.

Rejected: fixed 200-review/100-retained caps from `f8f547737c7` and `4e8feaac096`. No stored originals were truncated or migrated.

## Acceptance checklist

- [x] Import and review the three changes against current source contracts.
- [x] Connector regression: 23 tests across five suites.
- [x] Real SQL/PGlite persistence: six tests covering both write orders, insert races, repeated persistence, ownership and unsuccessful updates.
- [x] Core scenario/retention suites: 594 passing tests in the combined run.
- [x] Additional group provider-read and correction-dependency coverage: 455 tests across two overlapping suites (not additional unique tests).
- [x] Live synthetic group QA: one ignored Alice-addressed turn and one answered agent-addressed turn. Raw native tool outputs and persisted trajectories inspected.
- [x] Final root verification on the integrated candidate: `bun run verify` exited 0, including multi-target core builds, workspace type/lint checks and repository audits.
- [x] Final local commit and tag: `codex/group-channel-verified-20260920`.

## Live evidence

Model: Cerebras `qwen-3.8-27b`. These were small isolated group turns, not a production latency benchmark.

| Scenario | Total | Model calls | Model time | Input | Cached input | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Message addressed to Alice; agent stays silent | 593 ms | 1 response handler | 467 ms | 5,907 | 5,120 | 231 |
| Greeting addressed to agent; agent replies | 685 ms | 1 response handler | 608 ms | 5,892 | 0 | 271 |

Three paid foreground calls were used in total: an initial correct ignored turn exposed an outdated test reader that only inspected prose; the reader now inspects native tool-call output too, and the two-turn test passed. No paid loop, live Discord sends or user records were involved.

Raw evidence and summary:
`/Users/nubs/Documents/ChatGPT/test/eliza-group-channel-integration-20260920/`

Logs:
- `/tmp/eliza-discord-regression-20260920.log`
- `/tmp/eliza-discord-reply-real-final-20260920.log`
- `/tmp/eliza-group-final-tests-20260920.log`
- `/tmp/eliza-group-read-tests-20260920.log`
- `/tmp/eliza-group-live-final-20260920.log`
- `/tmp/eliza-group-acceptance-verify-20260920.log`

## Remaining release gates

Publishing/merging this candidate, a running app rebuilt from this candidate, actual Discord transport, voice/native-device checks and deployment are not established by this local acceptance. Existing demo ports still serve their previous checkpoints. Larger histories, production plugin sets and tool workflows can take more calls/time than these two synthetic greetings.

Final verification logs are also copied into the durable evidence directory above. No push, merge, app restart or deployment was performed. Original demo worktrees were rechecked clean at `9741f3a8b77`, `a15525f30fb` and `bd227d2f52e`.
