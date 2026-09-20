# Remote source review — September 20

Candidate: `654a31b14fb` (running code `3f46cd1362d`). Reviewed develop remains
`ec23d0f670c`. The remote repository was read through SSH and its two missing
commit objects fetched locally. No remote files, branches or services changed.

## Inventory

44 registered checkouts were inspected;24 have modified/untracked entries.
The full path/status inventory is stored locally in
`/Users/nubs/Documents/ChatGPT/test/eliza-consolidation-20260919/remote-checkout-status-20260920.json`.
These are preserved, not automatically staged or treated as recent work.

| Source | Evidence | Decision |
| --- | --- | --- |
| Mac mirror `f042ddb2ddd` | Clean; ancestor of candidate | Already included |
| Merge checkout `89a476f3d75` | Clean; ancestor of candidate | Already included |
| Stable sync2 `d0d478fe7dd` | 106 non-equivalent commits and4 patch equivalents by git cherry;127 files differ from the saved merge checkout | Review by behavior; do not merge wholesale |
| Group protocol `4e8feaac096` | Six unique commits above candidate ancestry | Decisions below; no group/channel acceptance claimed |

Patch uniqueness is not semantic uniqueness. File comparison for sync2 against
candidate:3 identical blobs,63 changed remotely while unchanged in candidate
since89a476f3d75,61 diverged. This includes reversions of existing protections;
"remote-only" is not an instruction to apply. Raw comparison and cherry lists
are beside the local inventory. Remaining sync2 files still need disposition.

## Group branch decisions

- `8657e653dde` and test `e569f87b1ff`: extend progressive history/tool discovery
  to text group channels. Preserve for a separate group-channel integration
  review. The current direct-chat candidate also has newer source binding,
  exact-reply and direct-voice contracts that this earlier patch predates.
  Do not replace current pipeline files with this branch's files.
- `5c69040b85a`: Discord canonical reply persistence has a useful independent
  objective: one stored row per response with chunk delivery IDs. Preserve for
  focused Discord integration and race/ownership testing. It is not currently
  integrated or accepted. No Discord message was sent during this audit.
- `f8f547737c7` and `4e8feaac096`: do not import the fixed200-source review
  window or100-source retained rotation as written. They bound model-facing
  review input, conflicting with the current complete-context contract.
  Retaining omitted records inline does not make the review input complete.
- `a3536706bf3`: incomplete classification keeps omitted candidates visible
  instead of rejecting the entire review. Preserve for review with the
  candidate's newer correction/dependency contract; no cherry-pick as a
  side effect of importing group mode or context limits.

## Sync2 inspected differences

| Surface | Observed remote difference | Disposition |
| --- | --- | --- |
| Agent prompt tracking | Converts missing temperature to0 and treats actual0 as replaceable | Keep current truthful telemetry |
| Stage-1 output parser | Uses first usable native decision and falls back to prose instead of rejecting conflicting native decisions | Keep current validation |
| OpenAI retries | Drops429 from exhausted shared retry suppression | Keep current rate-limit handling |
| Reminder target hints | Catches task-store failure and returns undefined without reporting | Keep current explicit failure behavior |
| LifeOps connector rendering | Comment expansion only; grouping implementation identical | No code integration needed |
| Batch queue | Changes drain return from void to processed count | Hold with its dependent idle-backoff changes; not a standalone optimization |

These decisions come from implementation diffs, not commit titles. This is a
partial remote review, not proof that every remote change is represented.
Local text QA, remote/channel acceptance and production release remain distinct.


## App/domain batch reviewed

54 implementation-file deltas now have explicit local ledger decisions. This
is not54 accepted changes or completion of all127 files. Paired tests are not
implicitly marked inspected. No runtime code changed in this review batch.

- Keep exact-ID Notes mutation and ID/text pairs. The older branch removes the
  former and replaces the latter with positional identity lists.
- Keep Calendar request-grounded extraction and explicit selector conflicts.
  The older branch adds English token/prefix filters that can discard literal
  values and silently falls back from a rejected ID to a title-matched target.
- Keep complete memory-search scope and terminal provider failure handling.
  Remote automatic first-page selection and extra account-error model attempts
  do not satisfy current completeness and paid-call discipline.
- Keep generic source URLs out of media-delivery suppression and keep exact
  entity metadata. A source link is not proof of media delivery; duplicate-looking
  identity strings are not interchangeable facts.
- Keep uncapped action receipts, exact-name discovery optimization and current
  lightweight direct-chat navigation descriptions.
- Hold search-settings retirement, connector routing refactor, queue idle-backoff
  and trajectory-file deletion for their own dependency/compatibility checks.
  These have not been accepted or silently imported.
- API chat persistence, sub-planner alias explanation and connector grouping
  differences inspected here are comments rather than missing implementation.

Complete path-specific findings are in the local `sync2-file-comparison.json`.
Remaining implementation, test and documentation deltas still require review.

Additional inspected UI/routing deltas preserve the current trajectory stage
labels, late background-run visibility and transcript resync. The remote version
removes those behaviors. Current provider-reference guidance and invalid native
decision rejection also remain. Voice prewarm/eligibility changes are held;
no force flag or voice behavior was changed. Named-tool descriptions keep their
parameter schemas and canonical grouping.

## Planner and history boundary review

Seven more implementation deltas were inspected against the saved merge base,
with the corresponding protections checked in candidate `44c1b62cc69`.

- Keep evaluator routes constrained to actual queued calls and the host's
  clipboard capability. The remote version removes those schema restrictions.
- Keep native history read/ready separation, source-label repair, chronological
  quote dependencies and lossless repeated-text encoding. The remote version
  removes these newer safeguards and can require additional context reads.
- Keep field guidance refreshed after every authorized context read and request
  a single Stage-1 native decision. The remote version weakens both boundaries.
- Planner prose additions expand explanations of existing rules; shared prompt
  changes are comments. Neither supplies a missing runtime capability.
- Hold the alternate inline action catalog for channel-specific review: it
  omits aliases, declared contexts and promoted child entries. Direct text
  already uses reference-only discovery, so this is not its missing speed fix.
- The remote evaluator's separate provider composition is coupled to its
  blanket provider exclusions, already rejected above. Do not import that
  restoration helper independently into the current composition contract.

The final three implementation deltas are reviewed below. Remaining test and
documentation deltas still need explicit disposition.
No runtime code or running demo changed during this batch; no paid calls ran.

## Final implementation batch and paired planner tests

All54 implementation deltas have a recorded disposition; eight paired planner
and evaluator test deltas were also inspected (62 of127 total paths reviewed).
This is source review, not acceptance of the remote branch or new runtime QA.

- Do not import the60-percent word-overlap completion gate, argument-subset
  queue dropping, English word-set reply suppression or whitespace flattening.
  Matching words and an applied operation family do not establish exact
  requested values, targets or completion of every clause.
- Preserve target-bound failure supersession. A failure tied only to a source
  message does not identify which target a later successful write resolved.
  The remote message-scoped exception needs explicit target correlation.
- Keep exact-name discovered schemas and an explicitly unavailable clipboard;
  replacing it with a no-op callback advertises an effect the host cannot apply.
- Reject post-turn oldest-history/result-prefix trimming, even when opt-in.
  Keep the dedicated extraction system contract. A skipped budget call also
  must not be presented as a successfully completed evaluation.
- Shared batch-scope placement in custom planner templates is an independent
  possible optimization, held for focused coverage. The default planner already
  carries the rule, so this is not a demonstrated missing direct-chat speed fix.
- Keep the existing tests for queue identity, literal formatting, explicit
  discovery despite a prior draft, semantic completion and distinct targets.
  Remote replacements mostly assert the shortcuts rejected above; their green
  results would not prove equivalence to the requested behavior.

No production source was changed or paid model call made in this review batch.

## Documentation and initial test reconciliation

84 of127 paths now have explicit dispositions:54 implementation files and30
supporting test/documentation files. The four changed remote AGENTS/CLAUDE pairs
were checked byte-for-byte before treating each pair as the same reviewed text.

Keep current documentation for exact-ID Notes updates, bound ID/content rows,
history reads and source repair, complete named-tool schema inspection, native
schema fallback, late trajectory refresh, browser metadata versus page reads,
and shared transient429 retry budgets. The remote documentation describes the
older implementations rejected above.

Keep the removed source-citation regressions, temperature provenance tests,
no-extra-call account failure tests, and native read/ready and source-label
repair cases. Their removal would hide regressions in current behavior.
Two additions warrant coverage comparison: discovery under a family's declared
contexts without mutating contextless state, and discovery visibility assertions
in the Stage-1 suite. These are not yet imported or claimed covered.

43 supporting paths remain unreviewed. No runtime changes or paid tests were
made during this documentation/test reconciliation batch.

## Remaining core test reconciliation

109 of127 paths now have dispositions. This batch inspected25 core test deltas.
Keep tests for multilingual STOP, conflicting native decisions, clipboard host
capabilities, exact history-source chronology/reassembly, complete named schemas,
and bounded account-error handling. Do not replace them with tests requiring
result/history truncation, blanket provider exclusions or missing action aliases.
Comment-only incident additions and fixture-only changes add no behavior.

Coverage comparison still needs the independent context-routing metadata,
experience exact-byte preservation, native/fallback schema parity and shared
block dedup cases, alongside the discovery cases noted above. They are not
implicitly accepted just because the associated optimization sounds useful.
18 UI/plugin/report paths remain unreviewed. No paid calls or runtime edits.

## File inventory review complete

All127 sync2 changed paths now have explicit dispositions:54 implementation
files and73 supporting test/documentation/report files. The full review is in
[REMOTE-SOURCE-DECISIONS.md](REMOTE-SOURCE-DECISIONS.md). This completes file
inspection, not the held dependency reviews or final candidate acceptance.

Keep exact-ID Notes execution/persistence and ID/body pairing tests. Keep Calendar
unresolved-target rejection rather than updating/deleting a different title match.
The new Calendar token/placeholder helper tests enforce the lexical shortcuts
already rejected; literal field values must remain possible. The relocated
plain-move PGlite test is not new coverage. Extra attendee syntax and optional-field
cases join the bounded coverage comparison before final disposition.

Keep trajectory late-run visibility, transcript resync and actual-stage labeling
tests. Voice test removals were inspected only; no voice testing occurred. Keep
real-local-HTTP408/429 shared retry-budget tests and cancellation without an
unrelated WEB_SEARCH fallback. The molecular-components report is formatting
only: full parsed JSON equality was verified.

No runtime changes or paid calls in this batch. Remaining work is resolving the
listed independent holds/coverage comparisons, applicable final QA and handoff.
