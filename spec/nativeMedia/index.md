# Native media

The Android [media rules](../os/android/media/catalog.md), [edit copies](../os/android/media/editCopy.md), and [reviewed replacement](../os/android/media/photoReplace.md) own platform custody. This package exposes the stable admission and readback contract shared by host media surfaces.

## Story: Review an exact device media item before sharing or changing it

> As the owner, I want actual permitted bytes from the item I selected and a visible distinction between an edit copy and a replacement.

### Media bytes and mutations need the same selection fence as the review

Each observation is scoped to the device user and provider volume, item identity, provider generation, and access epoch. Playback repeats the access check for every range request. Original replacement and permanent deletion additionally need matching owner review. The native adapter handles encoding, private backups and recovery.

```quint
type MediaOperation = ReadMediaBytes | PlayMedia | SaveEditCopy | ReplaceOriginal | TrashMedia | PermanentlyDeleteMedia
type MediaFence = { itemId: str, userScope: str, volumeId: str, providerRevision: int, accessEpoch: int }
pure def mayUseMedia(reviewed: MediaFence, observed: MediaFence, op: MediaOperation, stillPermitted: bool, ownerReviewed: bool): bool =
  reviewed == observed and reviewed.itemId != "" and reviewed.userScope != "" and reviewed.volumeId != "" and stillPermitted and
  ((op != ReplaceOriginal and op != PermanentlyDeleteMedia) or ownerReviewed)
pure def lawMediaChangeInvalidatesSelection(reviewed: MediaFence, observed: MediaFence, op: MediaOperation, stillPermitted: bool, ownerReviewed: bool): bool =
  reviewed.providerRevision != observed.providerRevision implies
  not(mayUseMedia(reviewed, observed, op, stillPermitted, ownerReviewed))
pure def lawReplaceOriginalNeedsReview(reviewed: MediaFence, observed: MediaFence, stillPermitted: bool): bool =
  not(mayUseMedia(reviewed, observed, ReplaceOriginal, stillPermitted, false))
pure val reviewedValues = Set({ itemId: "photo42", userScope: "owner", volumeId: "primary", providerRevision: 3, accessEpoch: 7 })
pure val observedValues = Set(
  { itemId: "photo42", userScope: "owner", volumeId: "primary", providerRevision: 3, accessEpoch: 7 },
  { itemId: "photo42", userScope: "owner", volumeId: "primary", providerRevision: 4, accessEpoch: 7 },
  { itemId: "photo42", userScope: "different-user", volumeId: "primary", providerRevision: 3, accessEpoch: 7 })
```
