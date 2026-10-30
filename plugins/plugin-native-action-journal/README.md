# @elizaos/capacitor-action-journal

A durable reserve -> apply -> finish journal for device actions an owner has approved.
It records what one approved dispatch did, at most once, so an app can recover after a
crash, a lost bridge callback or a dropped connection without repeating an effect.

- Android: `android/` holds the host-configured engine and Capacitor bridge
  (`ActionJournal`, `ActionJournalConfiguration`, `ActionJournalPlugin`). See
  `android/README.md` for host integration, slot identity and crash ordering.
- TypeScript: `registerActionJournal(name)` registers the host-named bridge;
  `nextStep(entry)` says whether a reserved entry may be dispatched or must be reconciled;
  `isJournalEntry` shape-checks bridge results. Browsers have no journal and fail closed.

## Reviewed deletion Undo window

`android/.../actionjournal/deletion` holds the shared, Android-free engine for deletions that
wait ten seconds after a foreground review (Calendar events, reminders):

- `DeletionDeadline` - the persisted monotonic deadline (`WINDOW_MS` = 10 s). A reboot or an
  unprovable clock reads as `CLOCK_CHANGED`: the row needs review and is never dispatched.
- `DeferredDeletionJournal` - durable staging, Undo, expiry and bounded history. Undo and
  expiry have one winner; a dispatching write reads back as `unknown` and is never replayed;
  a settled deletion is never reported as a successful Undo.
- `DeletionDispatchClaim` - the permanent `nativeDispatchClaim` that binds an agent-approved
  deletion to its exact action-journal entry before staging.
- `DeletionReceiptRecovery` - read-only settlement of a claimed `calendar_delete` or
  `reminder_cancel` entry from its Undo-window receipt. Missing evidence changes nothing.
- `DeferredDeletionCoordinator` - main-process admission over host ports: storage slots,
  monotonic clock, authenticated owner identity and review fence, the reminder engine
  (which suspends delivery at stage), Calendar provider writes and a wake-up scheduler.
  Owner network reads never run under its lock; an owner that changed or cannot be confirmed
  pauses the row instead of deleting.

Hosts keep the foreground review dialogs, the WorkManager (or equivalent) worker that calls
`reconcile()`, and their installed slot names. A provider that recreates an item (for example a
re-sent invitation) is not a lossless restore, so the window never offers one. The renderer
contract and the Undo notice are `@elizaos/contracts/deletion-window` and
`DeferredDeletionNotice` in `@elizaos/ui`.

The journal grants no approval and performs no action. Hosts keep owner/agent
authorization, the action itself, result admission (`ResultPolicy`) and any
receipt-based recovery.

`npm test` runs the TypeScript client checks and the JVM engine and deletion-window checks (the latter need
`javac` and an org.json jar; see `android/README.md`). These are synthetic unit checks; a
host's own instrumentation and device acceptance are still required.
