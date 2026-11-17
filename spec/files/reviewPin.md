# Reviewed file identity

A change the owner approves to a file on the device applies to the exact
file shown in the review. Per-row mutation and batches are
[scoped Files operations](./reviewedOperations.md); claim, journal and
retry are the agent's [device action custody](../agent/deviceActions/execution.md),
and the review contracts are [device action operations](../agent/deviceActions/operations.md).

## Story: Change only the file I reviewed

> As a user, when I approve a change to a file on my device, the change
> applies to the exact file I saw in the review. If the file was replaced in
> between, or the review was refreshed or abandoned, the replacement is left
> untouched.

### The review pins the identity it displayed, and a stale completion changes nothing

The coordinator owns the current review and its per-proposal identity pin,
and the storage volume compares that pin with the current storage object
before a revision-checked change commits. Each refresh starts a
newer review. When the current review reads the file's identity, it pins it
(or keeps an existing pin), displays it and binds the proposal to it. A
completion for any review that is no longer the latest leaves the pin, the
displayed identity and the proposal as they were. A refresh never moves an
existing pin to another object.

```quint
type FilesReview = { latest: int, pin: int, displayed: int, proposalToken: int, file: int, dispatched: bool, dispatchToken: int, appliedFile: int }
pure val initial: FilesReview = { latest: 0, pin: -1, displayed: -1, proposalToken: -1, file: 0, dispatched: false, dispatchToken: -1, appliedFile: -1 }
pure def canStartReview(fr: FilesReview): bool = not(fr.dispatched)
pure def startReview(fr: FilesReview): FilesReview = { ...fr, latest: fr.latest + 1 }
pure def canIdentityReturns(fr: FilesReview, review: int): bool = review >= 1 and review <= fr.latest
pure def identityReturns(fr: FilesReview, review: int): FilesReview = {
  val token = if (fr.pin >= 0) fr.pin else fr.file
  if (review != fr.latest) fr else { ...fr, pin: token, displayed: token, proposalToken: token }
}
pure val reviewValues = Set(1, 2, 3)
pure def canReplaceFile(fr: FilesReview): bool = fr.file == 0
pure def replaceFile(fr: FilesReview): FilesReview = { ...fr, file: 1 }
pure def alwaysPinMatchesDisplayedIdentity(fr: FilesReview): bool = fr.pin == fr.displayed
pure def alwaysProposalUsesThePin(fr: FilesReview): bool = fr.proposalToken >= 0 implies fr.proposalToken == fr.pin
pure def stepRefreshKeepsThePin(before: FilesReview, after: FilesReview): bool = (before.pin >= 0 and after.pin >= 0) implies after.pin == before.pin
pure val frValues = Set(initial, { ...initial, latest: 2 }, { ...initial, latest: 2, pin: 0, displayed: 0, proposalToken: 0, file: 1 })
pure def lawStaleCompletionChangesNothing(fr: FilesReview, review: int): bool = review != fr.latest implies identityReturns(fr, review) == fr
```

### One dispatch changes the reviewed object or nothing

The claim, journal and server admission are preconditions outside this model.
A single dispatch compares the preserved review token with the current object:
it changes the object only when they match, and leaves a replacement untouched.

```quint
pure def canDispatchChange(fr: FilesReview): bool = not(fr.dispatched) and fr.proposalToken >= 0
pure def dispatchChange(fr: FilesReview): FilesReview =
  { ...fr, dispatched: true, dispatchToken: fr.proposalToken, appliedFile: if (fr.file == fr.proposalToken) fr.file else -1 }
pure def alwaysOnlyTheReviewedObjectChanges(fr: FilesReview): bool = fr.appliedFile >= 0 implies fr.appliedFile == fr.dispatchToken
pure def sometimesReviewedFileChanged(fr: FilesReview): bool = fr.dispatched and fr.appliedFile == 0
pure def sometimesReplacementLeftUntouched(fr: FilesReview): bool = fr.dispatched and fr.appliedFile == -1 and fr.file == 1
```
