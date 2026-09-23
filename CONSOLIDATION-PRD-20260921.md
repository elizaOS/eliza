# Eliza consolidation PRD and acceptance record

This is the compact handoff contract for the demo product. It keeps the scope tied to the original August comparison and does not turn historical timing into a three-second SLA.

## Required behavior

1. A continuous one-to-one chat handles greetings, navigation, Notes, Calendar, recall, corrections, and follow-ups with one authoritative final reply.
2. Simple greetings, navigation, and ordinary chat take the direct path. Planner/evaluator/tool calls are used only when the request needs them.
3. Notes preserve explicit title/body text, whitespace, ownership, exact reads/edits, and ask before an ambiguous target or instruction/body boundary is changed.
4. Calendar never invents a missing clock time, treats “morning” as a precise time, or writes before required details are grounded. It checks availability and conflicts, explains blocked slots, and preserves unrelated events.
5. Context and memory reads preserve source ownership, corrections, speaker boundaries, and exact recalled text. A read or acknowledgement cannot claim an effect that did not happen.
6. Voice uses Cartesia through the local health-probed gateway. Force mode is diagnostic and explicit-only; provider, microphone, animation, and device-path checks are separate acceptance gates.
7. Every accepted change has focused evidence, a clean checkpoint, and a reviewable branch/PR. Protected `develop` and deployment remain separate approval gates.

## Current evidence — September 22

- Candidate: `codex/final-integration-20260921`, code checkpoint `e7771eb6196`, incorporating reviewed develop `b6a2e43c645`. [PR #32044](https://github.com/elizaOS/eliza/pull/32044) is mergeable at that checkpoint.
- Saved demo remains `3238445f60d` in its separate checkout with rollback tags. Port5288 is stopped. Current dev app: `http://127.0.0.1:5298/chat`, API31422, isolated copied QA data.
- Same-room and provider-original source parity is implemented; exact source quote and persisted link passed live. Augmented/redacted records cannot become protected originals.
- Stop retains terminal context even without delivered text. Live post-Stop greeting passed with zero tool calls. Transient acknowledgement appeared at1.81s and the single final Calendar response at4.07s; no progress text persisted as an answer.
- Notes create/edit/read, original-versus-current recall, Calendar missing-time clarification, explicit create, conflict alternatives and same-ID move have stored-state evidence. Calendar's mounted Month control passed.
- Personal-rule absence is checked in the actual requester preference store; live no-op preserved all stored preferences/facts. Exact positive removal with unrelated-rule preservation passes owning tests.
- Reviewed settings donor port is incorporated; the original peer worktree remains untouched.
- Verified code76e74 passed root verification, frozen install and commit-range secret scan. Assistant5165 and handler/recovery428 passed there; later navigation repair has412 handler tests and100 navigation tests. Final exact-head gate is pending.

## Open acceptance and limitations

The sole local ledger is `/Users/nubs/Documents/ChatGPT/test/LAST-MILE-20260922.md`.
Remaining work: final exact-head verification/CI, rebuilt guidance smoke and final handoff. The latest guidance corrects a mismatch with an existing planner path; no latency improvement is claimed without measurement.

Recent simple paths took0.90–1.52s, exact recall2.51s, Calendar3.75–4.07s, personal-rule absence5.08s and compound navigation/read6.41s. This does not meet a universal three-second target. Preserve authorization, conflict checks and effect grounding; acknowledgements improve feedback, not completion time.

Physical Cartesia microphone/audio/animation, recording, protected merge and deployment remain separate acceptance decisions. No claim of a complete launch product follows from these text checks.
