# Combined Eliza text candidate — September 20, 2026

The isolated candidate is available for text rehearsal at http://127.0.0.1:5268/chat.
This is a verified local text checkpoint, not a finished production release or a
promise that every request completes in three seconds.

## Use this checkout

- Checkout: `/Users/nubs/Git/eliza-consolidation-20260920`
- Branch: `codex/consolidation-20260920`
- Backend runtime source: `3f46cd1362d`; final UI correction: `1e230d820a4`.
  Subsequent commits change documentation only.
- UI5268 / API31392. API readiness checked: runtime/database healthy,35 plugins,
  95 services,zero failures,deferred boot settled. Browser reloaded after the UI
  hook change; Home navigation and persisted conversation verified afterward.
- Local checkpoint tag: `codex/consolidation-text-verified-20260920`.
- Earlier published branch checkpoint: `88c7419f6c2`. The final Stop fix and final
  evidence are local commits after that checkpoint; do not assume GitHub has them.
  No develop push, deployment or source-branch rewrite was performed.
- Original demo5248: `ganttnubs` at `bd227d2f52e4`; original demo5258:
  `codex/peer-context-integration-20260919` at `a15525f30fb3`. Both worktrees were
  freshly checked clean and both UI ports remain listening. Their own acceptance
  applies to their saved revisions, not automatically to this combined candidate.

## What is combined

Ancestry checks pass for the saved Mac source `a15525f30fb`, pinned develop
`ba04de0e2c1`, reviewed maintenance `ec23d0f670c`, earlier remote merge
`89a476f3d75`, and peer work `e59818bf174`. Develop is deliberately pinned;
this is not a claim to contain all commits published after the reviewed snapshot.

The original270-path inventory has267 include and3 upstream-equivalent decisions.
The newer sync2 remote head `d0d478fe7dd` has127 inspected file differences with
explicit retain/include/exclude/defer decisions. Existing connector-family
selection and context coverage were confirmed rather than imported twice.
The group head `4e8feaac096` is fetched and preserved with per-commit decisions.
Its progressive group context, Discord canonical chunk persistence and partial
classification changes are **not integrated**. Fixed context-window caps were
rejected because they violate the complete-context contract.

Read [REMOTE-SOURCE-DECISIONS.md](REMOTE-SOURCE-DECISIONS.md) for sync2 and
[REMOTE-SOURCE-REVIEW.md](REMOTE-SOURCE-REVIEW.md) for the group decisions.
The read-only remote inventory records44 worktrees,24 dirty/untracked. Those
working files were left untouched; an inventory is not acceptance of uncommitted
remote work. Other unspecified hosts remain unconfirmed.

## How the text paths work

| Request | Typical verified path | Boundary |
| --- | --- | --- |
| Greeting or ordinary reply | Handler replies | No unnecessary planner for simple chat |
| Go home / open Notes | Handler selects navigation; view action executes | Latest Go home:1 call,0.978s; browser visibly reached Home |
| Note write/edit, preference change | Handler/acknowledgment → planner/tool → grounded completion | Exact text, source ownership and receipts retained; no claim of universal model accuracy |
| Calendar availability | Handler/acknowledgment → planner/preview → grounded completion | No booking from an availability question; final wording checked against actual slots |
| Calendar missing time | Ask for the missing clock time | Morning/afternoon is not permission to invent a booking time |
| Calendar create/move | Resolve user-grounded fields and target; check conflicts; persist; explain result | Domain extraction may require another call; it was retained for correctness |
| Exact recall | Recover original authorized source evidence as needed | Context restoration may add a call; no fabricated fixed call count |
| Stop | Abort active request; invalidate pending setup | No rollback promise for effects already committed before Stop |

Acknowledgments are present: the latest Calendar preview said “Checking what's
open tomorrow morning.” before the final reply. They are progress, not a claim
that a write succeeded. History/source binding, receipt-based completion and
explicit tool schemas remain intact; no new prompt or model call was added by
the final Stop correction.

## Measured results, not guarantees

| Scenario | Backend total | Calls | Input | Reported cached input |
| --- | ---: | ---: | ---: | ---: |
| Clean Go home | 0.978s | 1 | 10,658 | 6,144 |
| Morning preview | 4.029s | 3 | 27,391 | 3,072 |
| Exact preference save | 2.780s | 3 | 23,226 | 3,072 |
| Follow-up preference removal | 3.015s | 3 | 24,523 | 10,240 |
| Personal reply-rule removal | 3.537s | 3 | 27,413 | 9,216 |

The morning-preview model calls were1.302s,0.653s and0.885s;1.189s remains other
backend work. That request also experienced a much longer pre-admission delay
on a page with React hot-update errors. Its4.029s is **not click-to-reply time**.
Reload recovered the page; the subsequent navigation succeeded. Do not blame
all observed latency on Wi-Fi or the model. Cached-input counts are provider
telemetry, not proof of a particular bill or a controlled caching benchmark.
Thirty-four paid QA turns total; no voice tests. No additional paid loops are
needed merely to regenerate these numbers.

## Verification and cleanup

- Full repository `bun run verify` passed after `1e230d820a4` (exit0).
- Final UI cancellation/ownership suites:150 passed. The new test failed before
  the fix: Stop during conversation creation still allowed a model dispatch.
  It now covers setup success/failure after Stop and a subsequent fresh send.
- Calendar:1,092 passed/four skipped; real-PGlite field/date suite29 passed;
  Calendar typecheck,lint and declaration build passed.
- Existing recorded suites include Notes192, personal-assistant Calendar60,
  recall57 and core13,661 passed; two initial core failures were corrected and
  their affected suites rerun. These are scoped runs across checkpoints, not a
  claim that the entire test universe was rerun at final HEAD.
- Reused coverage reconciliation:92 passed without live inference.
- Live evidence covers navigation, exact notes, original recall, Calendar
  clarification/create/conflict/move, exact preference save/removal and restart
  persistence, scoped reply-rule removal, and clean pre-effect Stop.
- Final Calendar read offered9:00,9:15 and9:30 AM, matching three15-minute slots.
  No mutation tool ran; reply persisted after reload.
- Owned Cedar note/event and temporary garden/greenhouse preferences were removed.
  Nine baseline memory facts matched their pre-test values. Notes UI is empty.
- Visual evidence:230 checks passed;23 soft flags reviewed; OCR212 verified with
  zero regressions and12 expected fallbacks. This is not complete device coverage.

Full chronology, failures and evidence filenames: [CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).
Local raw artifacts:
`/Users/nubs/Documents/ChatGPT/test/eliza-consolidation-20260919/`.
Do not publish raw trajectories without checking their contents.

## Remaining release gates

1. Resolve the historical late-arriving/build-time request sufficiently for
   release. The setup Stop bug is fixed and a hot-update failure was observed,
   but neither establishes the old incident's cause. Use a clean reloaded or
   packaged UI for rehearsal, not an in-place hook hot update.
2. Consistent under3s completion is not achieved. Calendar preview remains around
   3.6–4.0s in recorded backend runs; tail latency and click-to-reply need a
   deliberate small benchmark if a release SLO is required.
3. Local Calendar recurring events are unsupported. Rejection and one-off
   preservation were tested; recurring availability and external invitations
   are not accepted. Do not demo successful local weekly booking.
4. Group/Discord changes and search-settings retirement need their own integration
   and compatibility acceptance before claiming all remote work is combined.
5. Native installation remains gated on Xcode/Metal prerequisites. Remote/dedicated
   startup, staging, fresh-install/upgrade, device, voice and deployment acceptance
   remain unestablished. Three family-interview hover controls across four viewports
   remain unverified. These are release work, not evidence of passed local text QA.
6. User rehearsal, reviewable PR/merge and exact-artifact release approval are still
   required before launch. No PR or production release was created by this handoff.

## Next operator steps

Use the candidate5268 for a short text rehearsal. Preserve the checkpoints and
original demos. If integration scope expands to groups, Discord or another remote
host, open the source decisions first and test that domain explicitly. Do not
replace current pipeline files with older remote versions or repeatedly retest
paid scenarios without a concrete uncertainty to resolve.
