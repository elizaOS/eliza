# Eliza consolidated candidate and Shaw handoff

Branch: `codex/consolidated-eliza-20260923`. Included develop cutoff: `ff48eeb4193`.
Status: **QA/performance and preservation audit remain open; not approved for release.**

## Integration boundary

Shaw's `shaw/mega-refactor` at `b45c2b8525b` includes our branch through `0730db6be16`. This checkout stays separate while he refactors. Do not repeat the old consolidation or assume later commits are included. Follow-up `ae86a28b62a` clarifies tool loading and optional evaluator context reads. Experimental reasoning change `816bad9bca5` was reverted by `7bc7bc3f0a4`; their net code change is zero. No new PR, protected merge, deployment, branch deletion or PR closure was performed by this task.

## What is preserved and changed

- One continuous text/voice conversation path, navigation receipts, transient acknowledgments and authoritative final replies.
- Noncoding response handlers use authorized tool discovery rather than preloading the entire action catalog. Coding retains its established contract.
- Original dialogue, correction dependencies, standing preferences and permissions remain intact. Selected sources can be restored without truncation.
- Calendar next-event projections declare limited coverage; agendas use complete scoped reads. Missing clock times pause writes; conflicts block overlapping changes.
- Complete Calendar read records are represented once. Optional LifeOps records are deferred while standing constraints remain available.
- Semantic applied-effect checks require committed receipts; exact Notes edits preserve unrelated text and use existing revision/atomic-write guards.
- Direct human STOP decisions receive one bounded review; ordinary successful replies add no call. Genuine silence, bot/group/coding boundaries and cancellation retain their gates.

## Observed QA, not universal performance guarantees

| Scenario | Result | Foreground calls | Observed runtime |
| --- | --- | --- | --- |
| Greeting / Home | Correct | 1 each | 1.00s / 1.08s |
| Navigation follow-up | Correct | 1 | 1.72s |
| Exact note creation | Stored exact text | 3 | 5.08s |
| Exact note recall | Correct current text | 1 | 1.33s |
| Note edit | Correct; discovery or model retries can add calls | 3–5 | 4.00–10.57s across recorded runs |
| Calendar missing-time clarification | Asked; no write | 1 | 1.44s |
| Calendar creation after time supplied | One correct event; unnecessary recovery observed | 6 including extraction | 8.10s |
| Calendar conflict | Blocked; existing events preserved | 4 including extraction | 6.88s |
| Synthetic Cartesia two-event agenda | Both events correct; acknowledgment | 3 | 4.03s; first audio1.68s after final transcription |

Separate background-memory calls are recorded in the private metrics; they are not included in the foreground counts. Cached tokens are provider-reported, not assumed. A three-stage design does not guarantee three calls: extraction, discovery and validation recovery are separately counted.

Root verification passed at `0730db6be16`; final follow-up verification passed at `7bc7bc3f0a4` (net source equals `ae86a28b62a`). Existing routing445 and discovery47 tests passed. Exact stored Notes and Calendar state was inspected; unrelated records remained unchanged. Physical microphone/playback/animation acceptance is separate from synthetic Cartesia protocol proof. The actual assistant bundle must be rebuilt and fingerprinted before runtime testing; a source-only restart did not load two late changes, and those runs are explicitly excluded from change-effect claims.

## Remaining gates

- Finish the two-week preservation expansion. The original159branch-name audit is a cutoff snapshot, not exhaustive proof; additional refs include duplicates, already-contained history and separate Cloud/recovery archives. No saved ref was deleted.
- Resolve or explicitly qualify avoidable discovery/recovery overhead and provider latency. The sub3-second target is not met for every action flow; do not remove correctness guards to advertise it.
- Final candidate verification, matching runtime artifact, concise user QA and video. User approval precedes publication/integration; Shaw's refactor requires combined QA after he takes any later fixes.

The authoritative local tracker is `/Users/nubs/Documents/ChatGPT/test/consolidation-20260923/CURRENT-STATUS.md`; full trajectories, scope decisions, failed experiments and timing evidence stay local. Historical public status text is preserved in that evidence directory. No private payloads or credentials are included here.
