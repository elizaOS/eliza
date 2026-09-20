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
