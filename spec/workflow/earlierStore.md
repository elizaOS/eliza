# Workflows saved by the earlier version

The earlier workflow plugin kept the agent's workflows in the `workflow`
schema of the agent's database: saved workflows, their captured revisions,
their runs and the hosted digest sources, each row under the agent it
belongs to. This version keeps them in its own `workflow_*` tables
([admission](./admission.md), [lifecycle](./lifecycle.md),
[hosted digests](./hostedDigest.md)). When an agent that ran the earlier
version starts this one on the same database, the service carries what this
version can run across once, and says what it did not carry.

## Story: Keep the workflows I saved before this version

> As the owner, I want the workflows, schedules, digest loops and their
> sources and the run history I saved with the earlier workflow store to be
> here after the update, once, and never over anything I saved since, and to
> see which earlier workflows this version cannot run.

### The earlier workflow store is imported once, in one commit, and never again

When the service opens and holds no import receipt for its agent, it reads
the earlier store's rows of that agent; rows the earlier store quarantined
under no agent are never read. No earlier store means nothing to import
and no receipt. A readable earlier store is imported in one commit that
also keeps an import receipt naming when it ran, how many workflows, runs
and sources it carried, and each earlier workflow it did not carry, with
why. Once that receipt is kept the earlier store is never read again, and
the import never changes or removes it. An earlier store that cannot be
read, or an import whose commit fails, writes nothing and keeps no
receipt, so the next start imports again from the same store; the service
still opens. Nothing already in this version's store is changed by the
import. The workflow status the service answers carries the kept receipt.

```quint
type EarlierStore = EarlierAbsent | EarlierReadable | EarlierUnreadable
type ImportReceipt = NoImportReceipt | ImportReceiptKept
type StoreImport = NothingToImport | ImportEarlierStore | KeepImported | ImportAtNextStart
pure def storeImport(receipt: ImportReceipt, earlier: EarlierStore): StoreImport =
  if (receipt == ImportReceiptKept) KeepImported
  else if (earlier == EarlierAbsent) NothingToImport
  else if (earlier == EarlierReadable) ImportEarlierStore
  else ImportAtNextStart
pure def importSettled(committed: bool): ImportReceipt = if (committed) ImportReceiptKept else NoImportReceipt
pure def lawAnImportedStoreIsNeverReadAgain(earlier: EarlierStore): bool = storeImport(ImportReceiptKept, earlier) == KeepImported
pure def lawAnUnreadableStoreIsImportedLater(receipt: ImportReceipt): bool =
  receipt == NoImportReceipt implies storeImport(receipt, EarlierUnreadable) == ImportAtNextStart
pure def lawAFailedCommitKeepsNoReceipt(earlier: EarlierStore): bool =
  storeImport(importSettled(false), earlier) != KeepImported
```

### An earlier workflow comes back with its reviewed steps or digest preset, and on only where this version would turn it on

An earlier workflow with reviewed phone steps that validate in this version
comes back as a typed workflow with the same ID, name, description, steps,
trigger and times, and with each distinct earlier reviewed version as its
revision history, oldest first. An earlier digest loop whose preset
validates and whose source was carried at the revision it reviewed comes
back as a digest with the same preset and source. Any other earlier
workflow is not carried and is named in the import receipt: one written as
workflow source for the earlier engine, one whose steps or preset do not
validate, one whose source is missing or changed, and one whose ID is
already taken in this version's store. A carried workflow is on only when
it was on before, was not removed, and is a digest whose preset is enabled
or a typed workflow with a time trigger; otherwise it comes back off, and
an earlier digest that comes back off says so in its preset. A removed
workflow comes back removed, and the service clears its schedule before it
can be restored. Version numbers restart at this version's numbering.

```quint
type EarlierForm = EarlierTyped | EarlierDigest | EarlierSource
type CarriedAs = CarriedTyped | CarriedDigest | NotCarried
pure def carriedAs(form: EarlierForm, validates: bool, sourceFound: bool, idTaken: bool): CarriedAs =
  if (idTaken or not(validates)) NotCarried
  else match form {
    | EarlierTyped => CarriedTyped
    | EarlierDigest => if (sourceFound) CarriedDigest else NotCarried
    | EarlierSource => NotCarried
  }
pure def carriedActive(carried: CarriedAs, active: bool, removed: bool, timed: bool, presetOn: bool): bool =
  active and not(removed) and match carried {
    | CarriedTyped => timed
    | CarriedDigest => presetOn
    | NotCarried => false
  }
pure def lawEarlierSourceIsNeverCarried(validates: bool, sourceFound: bool, idTaken: bool): bool =
  carriedAs(EarlierSource, validates, sourceFound, idTaken) == NotCarried
pure def lawATakenIdIsNeverWrittenOver(form: EarlierForm, validates: bool, sourceFound: bool): bool =
  carriedAs(form, validates, sourceFound, true) == NotCarried
pure def lawAnImportNeverTurnsOnAWorkflowThatWasOff(carried: CarriedAs, removed: bool, timed: bool, presetOn: bool): bool =
  not(carriedActive(carried, false, removed, timed, presetOn))
pure def lawARemovedWorkflowComesBackOff(carried: CarriedAs, active: bool, timed: bool, presetOn: bool): bool =
  not(carriedActive(carried, active, true, timed, presetOn))
pure def lawAManualTypedWorkflowComesBackOff(active: bool, removed: bool, presetOn: bool): bool =
  not(carriedActive(CarriedTyped, active, removed, false, presetOn))
```

### Earlier runs come back as finished history, and an earlier run that had not finished never continues

Each run of a carried workflow comes back with its ID, status, input,
output, error, events and times, and the version it ran when the earlier
store names one this import carried, else the carried workflow's current
version. A run the earlier store had not finished comes back cancelled,
saying the update stopped it before it finished and that it will not run
later; it is never resumed, retried or approved. Runs of a workflow that
was not carried are not imported, nor is a run whose ID is already taken.
Digest sources come back with their ID, revision, text, freshness window
and revocation, the earlier revocation mark included; digest results
already delivered to a phone, and the phone's delivery cursors, are not
carried.

```quint
type EarlierRun = EarlierRunFinished | EarlierRunUnfinished
type ImportedRun = KeptFinished | StoppedByTheUpdate | RunNotImported
pure def importedRun(earlierRun: EarlierRun, workflowCarried: bool, idTaken: bool): ImportedRun =
  if (not(workflowCarried) or idTaken) RunNotImported
  else if (earlierRun == EarlierRunFinished) KeptFinished
  else StoppedByTheUpdate
pure def lawAnUnfinishedEarlierRunNeverContinues(workflowCarried: bool, idTaken: bool): bool =
  importedRun(EarlierRunUnfinished, workflowCarried, idTaken) != KeptFinished
pure def lawRunsFollowTheirWorkflow(earlierRun: EarlierRun, idTaken: bool): bool = importedRun(earlierRun, false, idTaken) == RunNotImported
pure def lawATakenRunIdIsNeverWrittenOver(earlierRun: EarlierRun, workflowCarried: bool): bool = importedRun(earlierRun, workflowCarried, true) == RunNotImported
```
