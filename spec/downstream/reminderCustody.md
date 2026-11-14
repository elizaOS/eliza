# AlphaPhone reminder creation and action custody

AlphaPhone consumes `reminder-journal.ts`, `reminder-contract.ts` and
`reminder-create-contract.ts` at Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. See [capability admission](./clockReminder.md).
The journal uses validated JSON and atomic compare-and-edit over a store
owned by the current connection. Creation allows 32 entries and evicts
confirmed entries first. An action store allows 100. Both have a 128 KiB
serialized bound. A native outcome valid for a different journal entry
leaves the current entry pending.

## Story: Recover a reminder write without repeating an uncertain effect

### A retained creation or revision-bound action has independent readback

A creating handler saves its exact request before calling native. It may
remove a retained request before dispatch. After dispatch, a creation is
found only with exact saved-row evidence. Removing a definitively
refused creation requires a fresh read with the ID absent. A pending
action instead acknowledges a succeeded, exact operation receipt whose
status, occurrence, intended edit and timing pass the action decoder.
A failed comparison or transport error preserves an uncertain entry
for a later read. Reconciliation is read-only at the native boundary.
An explicit owner discard follows a warning and can leave a native
effect outstanding. A discarded journal record cannot be applied to a
successor's request. The model uses one retained key and projects exact
CAS, device row and receipt comparisons as validated evidence.

```quint
type JournalKind = CreationRequest | RevisionAction
type JournalPhase = JournalEmpty | JournalPrepared | JournalDispatched | JournalFound | JournalAcknowledged | JournalDiscarded
type ReminderJournal = { phase: JournalPhase, kind: JournalKind, effectSent: bool, mayStillLand: bool }
pure val initial: ReminderJournal = { phase: JournalEmpty, kind: CreationRequest, effectSent: false, mayStillLand: false }
pure def canRetainReminder(j: ReminderJournal, kind: JournalKind, exactCas: bool, space: bool): bool = j.phase == JournalEmpty and exactCas and space
pure def retainReminder(j: ReminderJournal, kind: JournalKind, exactCas: bool, space: bool): ReminderJournal = { ...j, phase: JournalPrepared, kind: kind }
pure def canSendReminder(j: ReminderJournal): bool = j.phase == JournalPrepared
pure def sendReminder(j: ReminderJournal): ReminderJournal = { ...j, phase: JournalDispatched, effectSent: true, mayStillLand: true }
pure def canForgetUnsentReminder(j: ReminderJournal, exactCas: bool): bool = j.phase == JournalPrepared and exactCas
pure def forgetUnsentReminder(j: ReminderJournal, exactCas: bool): ReminderJournal = { ...j, phase: JournalDiscarded }
pure def canFindCreation(j: ReminderJournal, exactRow: bool, exactCas: bool): bool = j.kind == CreationRequest and j.phase == JournalDispatched and exactRow and exactCas
pure def findCreation(j: ReminderJournal, exactRow: bool, exactCas: bool): ReminderJournal = { ...j, phase: JournalFound, mayStillLand: false }
pure def canAcknowledgeReminder(j: ReminderJournal, succeededReceipt: bool, exactOutcome: bool, exactCas: bool): bool =
  j.kind == RevisionAction and j.phase == JournalDispatched and succeededReceipt and exactOutcome and exactCas
pure def acknowledgeReminder(j: ReminderJournal, succeededReceipt: bool, exactOutcome: bool, exactCas: bool): ReminderJournal =
  { ...j, phase: JournalAcknowledged, mayStillLand: false }
pure def canForgetRefusedCreation(j: ReminderJournal, definiteRefusal: bool, idAbsent: bool, exactCas: bool): bool =
  j.kind == CreationRequest and j.phase == JournalDispatched and definiteRefusal and idAbsent and exactCas
pure def forgetRefusedCreation(j: ReminderJournal, definiteRefusal: bool, idAbsent: bool, exactCas: bool): ReminderJournal =
  { ...j, phase: JournalDiscarded, mayStillLand: false }
pure def canForgetUnconfirmedReminder(j: ReminderJournal, ownerWarned: bool, noConfirmedCreation: bool, exactCas: bool): bool =
  j.phase == JournalDispatched and ownerWarned and exactCas and (j.kind == RevisionAction or noConfirmedCreation)
pure def forgetUnconfirmedReminder(j: ReminderJournal, ownerWarned: bool, noConfirmedCreation: bool, exactCas: bool): ReminderJournal =
  { ...j, phase: JournalDiscarded }
pure def alwaysReminderReceiptWasDispatched(j: ReminderJournal): bool =
  (j.phase == JournalDispatched or j.phase == JournalFound or j.phase == JournalAcknowledged) implies j.effectSent
pure def alwaysReminderWasRetainedBeforeSend(j: ReminderJournal): bool = (j.phase == JournalEmpty or j.phase == JournalPrepared) implies not(j.effectSent)
pure def alwaysReminderPendingEffectIsUncertain(j: ReminderJournal): bool =
  (j.phase == JournalDispatched implies j.mayStillLand) and (j.mayStillLand implies j.effectSent and (j.phase == JournalDispatched or j.phase == JournalDiscarded))
pure def stepOnlyLiveHandlerDispatchesReminder(before: ReminderJournal, via: str, after: ReminderJournal): bool =
  (not(before.effectSent) and after.effectSent) implies via == "sendReminder"
pure def sometimesCreationFound(j: ReminderJournal): bool = j.phase == JournalFound
pure def sometimesActionAcknowledged(j: ReminderJournal): bool = j.phase == JournalAcknowledged
pure def sometimesDiscardLeavesNativeUncertain(j: ReminderJournal): bool = j.phase == JournalDiscarded and j.mayStillLand
```
