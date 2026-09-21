# Group-channel integration acceptance

Base: `9741f3a8b77` from the verified consolidation worktree.
Candidate: `codex/group-channel-integration-20260920`.
The existing app processes and demo worktrees remain unchanged.

## Checklist

- [x] Import the canonical Discord reply persistence change from `5c69040b85a`.
- [x] Cover the SQL insert race, connector-first persistence, repeat delivery persistence, ownership mismatch, and failed update reporting.
- [ ] Complete connector regression, build, type and lint checks and root verification.
- [ ] Adapt progressive text-group discovery from `8657e653dde` and `e569f87b1ff` to the current core, preserving newer direct-voice behavior, source dependencies, permissions and cancellation.
- [ ] Review partial history classification from `a3536706bf3` against current checkpoint validation; include only if compatible and necessary.
- [ ] Run focused group addressing, source-restoration and planner tests; verify complete context recovery and unchanged coding/group-voice paths.
- [ ] Inspect a minimal live-model trajectory using an isolated local harness, with no Discord sends, before accepting changed model behavior.
- [ ] Commit the reviewed candidate and record exact verification evidence and remaining release gates.

Excluded: fixed 200-review/100-retained caps from `f8f547737c7` and `4e8feaac096`; deployment; voice QA; real Discord sends. No speed claim or release acceptance follows from local unit tests alone.

## Evidence so far

2026-09-20: 23 connector regression tests pass and six SQL/PGlite tests pass. The latter force core insertion between connector lookup and insertion; verify delivery-first followed by core and a repeat; reject a different room, author or agent; and reject an unsuccessful metadata update. No paid inference used.

Initial standalone tests/typecheck required generated workspace artifacts. The normal root verification pipeline is building those prerequisites; do not treat initial missing-artifact errors as product regressions or claim the full gate passed before it finishes.

The imported connector patch did not handle SQL's conflict-ignoring insert race. The candidate reads the actual stored row after insertion, verifies agent/author/room ownership and adds delivery metadata to that row. Existing content and action fields are retained.

The root verification command passed once (log `/tmp/eliza-group-verify-20260920.log`). A final run is pending after tightening the candidate ownership guard; six database tests and focused Biome checks pass on that guard. Connector build and typecheck completed during root verification.
