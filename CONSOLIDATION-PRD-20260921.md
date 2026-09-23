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

- Integrated code checkpoint: `codex/final-integration-20260921` / `d1c3d1107e1`, incorporating develop through `049d204238a`. Review in [PR #32044](https://github.com/elizaOS/eliza/pull/32044).
- Preserved demo: `codex/final-text-integration-20260920` / `3238445f60d`, with existing rollback tags retained. Port 5288 is stopped; it is not the current test app.
- Current test app: `http://127.0.0.1:5298/chat`, API31422, using an isolated copy of QA data. Serving identity must be checked after each rebuild/restart.
- Source/reference parity is implemented for authorized same-room and provider originals, including literal delivery and persisted same-room backward links. Provider redaction, discovery, source identity and final audience checks remain authoritative.
- The separately reviewed settings draft is incorporated at `816a935ab35`; the original peer worktree remains untouched. Owning tests pass.
- Current offline checks: 5,163 assistant tests; 446 focused core Stage1/sanitizer/envelope tests; three real database-backed recall tests; owning provider tests, types and builds. Counts overlap and are not additive.
- Earlier live evidence verified Notes create/edit/read, original-versus-corrected recall, Calendar missing-time no-write, explicit create, conflict/free alternatives and same-ID move. Latest bounded run on `03ca44931ea`: Notes navigation0.99s, note recall0.90s, Calendar create3.75s, Home4.56s. The Home outlier used a safe planner fallback for conflicting model flags.

## Remaining acceptance

Final remote refresh found develop `b6a2e43c645` (13 newer commits), including overlapping Stage1 review-budget changes. The pushed checkpoint is preserved; that integration conflict and exact-head gates must be resolved before handoff. Root verification last passed at `62ea2575407` before the live-discovered Stop, quote-format and preference-routing repairs.


The current local acceptance ledger is `/Users/nubs/Documents/ChatGPT/test/LAST-MILE-20260922.md`. It owns the remaining exact-head repository verification and bounded UI observations: mounted Calendar controls, transient acknowledgement/single final, Stop/idle/no replay, greeting, Calendar navigation, scoped preference removal and source quotation. Earlier unaffected scenario receipts should be reused; avoid broad paid retest loops.

Physical Cartesia microphone/audio/animation, recording, protected-branch merge and deployment remain separate acceptance decisions. Correct text behavior and a pushed checkpoint do not establish those outcomes. The three-second latency target is not a universal SLA; acknowledgements improve feedback without reducing measured completion time.
