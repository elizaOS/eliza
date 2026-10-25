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

The journal grants no approval and performs no action. Hosts keep owner/agent
authorization, the action itself, result admission (`ResultPolicy`) and any
receipt-based recovery.

`npm test` runs the TypeScript client checks and the JVM engine checks (the latter need
`javac` and an org.json jar; see `android/README.md`). These are synthetic unit checks; a
host's own instrumentation and device acceptance are still required.
