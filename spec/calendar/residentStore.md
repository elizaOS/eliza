# Resident calendar store

The agent's own resident calendar keeps one document Calendar per
account: its series rows, overrides and exclusions
([event and series scope](./seriesScope.md)). An earlier version kept
each account's resident events as a flat list of event records. This
spec owns moving that earlier record into the series rows.

## Story: Keep the calendar events I saved before this version

> As the owner, I want the events my agent's own calendar held before
> the update to be there after it, once, exactly, and never to overwrite
> what I saved since.

### The earlier events are imported once, exactly, and never over the series rows

When the account's series rows have never been saved, the agent reads
the earlier record of that account's resident events. A valid record
becomes the series rows with the same events, each a one-off row with
its title, notes, location, start, end, all-day flag and zone, and with
its provider version as its revision, so a change reviewed against the
earlier event still binds. Its replay keys come along, so a retried
change answers as before. The rows get a revision one past the earlier
record's, and an import receipt naming the earlier format, its revision,
its SHA-256 and the number of events. No earlier record means an empty
calendar. An earlier record that cannot be read or validated, or that
holds an event the rows cannot keep exactly, makes the calendar
unavailable for review and never starts an empty one. The rows and the
receipt are one write: once they are saved, the earlier record is never
read again, and it is never changed or removed. A crash before that
write leaves nothing saved, and the next read imports again from the same
record to the same rows.

```quint
type PriorResident = PriorAbsent | PriorValid | PriorInvalid | PriorUnreadable
type ResidentHolds = NothingSaved | SavedRows
type ResidentImport = StartEmpty | ImportPrior | KeepRows | ImportNeedsReview
pure def residentImport(holds: ResidentHolds, prior: PriorResident): ResidentImport =
  if (holds == SavedRows) KeepRows
  else if (prior == PriorAbsent) StartEmpty
  else if (prior == PriorValid) ImportPrior
  else ImportNeedsReview
pure def residentImportedRevision(priorRevision: int): int = priorRevision + 1
pure def residentImportSettled(rowsSaved: bool, receiptReadBack: bool): bool = rowsSaved or receiptReadBack
pure val priorRevisionValues = Set(0, 3)
pure def lawImportNeverOverwritesTheRows(prior: PriorResident): bool = residentImport(SavedRows, prior) == KeepRows
pure def lawBrokenPriorNeverStartsEmpty(holds: ResidentHolds): bool =
  residentImport(holds, PriorInvalid) != StartEmpty and residentImport(holds, PriorUnreadable) != StartEmpty
pure def lawImportedRevisionAdvances(priorRevision: int): bool = residentImportedRevision(priorRevision) > priorRevision
pure def lawUnsavedImportIsNotSettled(receiptReadBack: bool): bool = residentImportSettled(false, receiptReadBack) == receiptReadBack
```
