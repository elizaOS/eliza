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

## Current evidence

- Text checkpoint: `codex/final-text-integration-20260920` / `acda9b399844` / tag `codex/final-text-verified-20260920`.
- Current-develop voice correction: `codex/final-integration-20260921` / `7248c6c95b9` / [PR #32044](https://github.com/elizaOS/eliza/pull/32044).
- Historical consolidation: [PR #32042](https://github.com/elizaOS/eliza/pull/32042), intentionally draft because current `develop` relocated the runtime and the broad diff conflicts.
- Local handoff: `FINAL-HANDOFF-20260921.md` and `FINAL-INTEGRATION-STATUS-20260921.md`.

## Open gates

- Port the remaining historical behavior by semantic comparison onto current `develop`; do not merge the broad conflicting branch wholesale.
- Build the current workspace dependency graph, then run current assistant, Notes, Calendar, and voice-readiness suites.
- Perform the physical Talk check for Cartesia microphone capture, animation, audio, and device path.
- Only after those pass: request review/merge, deploy, and record a final demo readiness decision.

No new Cerebras calls are required for this audit pass.
