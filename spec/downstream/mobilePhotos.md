# Alpha and Grace native photo permission epochs

Grace's `DevicePhotosPlugin` and Alpha's `AlphaPhotosPlugin` both
use the pinned `PermittedPhotosPlugin` and
`PermittedMediaCatalog` from `plugin-native-media/android`. Alpha's
`NativePhotosOwnership.qnt` has separate publication and native
review models. This file specifies the publication fence shared by
both consumers. This isolated request crosses worker admission and
main-thread delivery. The owner maintains the permission epoch
across arrivals, so replacing or adding another read cannot refresh
this request's ticket.

## Story: Publish a photo only through the permission that admitted the read

### Scope changes and lifecycle retirement revoke both queued and completed reads

A read requires an unlocked foreground owner when it captures
permission and again before worker I/O and main-thread publication.
The host refreshes the permission snapshot before each check. A
changed permission snapshot or explicit invalidation increments
the epoch. Leaving or reentering foreground and locking the
device also retire earlier tickets. A native result from an older
ticket remains unavailable even if the original permission later
returns. Each read publishes at most once. Recoverable Android
failures settle as explicit rejections.

```quint
type PhotoReadPhase = BeforeRead | ReadQueued | ReadingPhoto | AwaitPublication | PhotoPublished | PhotoRefused
type PhotoRead = {
  phase: PhotoReadPhase, epoch: int, actualAccess: int, checkedAccess: int,
  ticket: int, publishedEpoch: int, foreground: bool, unlocked: bool, closed: bool
}
pure val initial: PhotoRead = {
  phase: BeforeRead, epoch: 0, actualAccess: 0, checkedAccess: -1, ticket: -1,
  publishedEpoch: -1, foreground: true, unlocked: true, closed: false
}
pure def usablePhotoOwner(s: PhotoRead): bool = s.foreground and s.unlocked and not(s.closed)
pure def inspectedEpoch(s: PhotoRead): int = if (s.actualAccess == s.checkedAccess) s.epoch else s.epoch + 1
pure def effectivePhotoTicket(s: PhotoRead): bool =
  usablePhotoOwner(s) and s.ticket >= 0 and s.ticket == inspectedEpoch(s)
pure def withCheckedAccess(phase: PhotoReadPhase, s: PhotoRead): PhotoRead =
  if (usablePhotoOwner(s)) {...s, phase: phase, epoch: inspectedEpoch(s), checkedAccess: s.actualAccess}
  else {...s, phase: phase}
pure def canAdmitPhotoRead(s: PhotoRead): bool = s.phase == BeforeRead
pure def admitPhotoRead(s: PhotoRead): PhotoRead =
  if (usablePhotoOwner(s)) {...withCheckedAccess(ReadQueued, s), ticket: inspectedEpoch(s)}
  else {...s, phase: PhotoRefused}
pure def canBeginPhotoRead(s: PhotoRead): bool = s.phase == ReadQueued
pure def beginPhotoRead(s: PhotoRead): PhotoRead =
  withCheckedAccess(if (effectivePhotoTicket(s)) ReadingPhoto else PhotoRefused, s)
pure def canFinishPhotoRead(s: PhotoRead): bool = s.phase == ReadingPhoto
pure def finishPhotoRead(s: PhotoRead, nativeOk: bool): PhotoRead =
  {...s, phase: if (nativeOk) AwaitPublication else PhotoRefused}
pure def canPublishPhotoRead(s: PhotoRead): bool = s.phase == AwaitPublication
pure def publishPhotoRead(s: PhotoRead): PhotoRead =
  if (effectivePhotoTicket(s)) {...withCheckedAccess(PhotoPublished, s), publishedEpoch: inspectedEpoch(s)}
  else withCheckedAccess(PhotoRefused, s)
pure def canChangePhotoAccess(s: PhotoRead, access: int): bool = not(s.closed) and access >= 0 and access != s.actualAccess
pure def changePhotoAccess(s: PhotoRead, access: int): PhotoRead = {...s, actualAccess: access}
pure val accessValues = Set(0, 1, 2)
pure def invalidatePhotoAccess(s: PhotoRead): PhotoRead = {...s, epoch: s.epoch + 1}
pure def canPausePhotos(s: PhotoRead): bool = s.foreground and not(s.closed)
pure def pausePhotos(s: PhotoRead): PhotoRead = {...s, foreground: false, epoch: s.epoch + 1}
pure def canResumePhotos(s: PhotoRead): bool = not(s.foreground) and not(s.closed)
pure def resumePhotos(s: PhotoRead): PhotoRead = {...s, foreground: true, epoch: s.epoch + 1}
pure def canLockPhotos(s: PhotoRead): bool = s.unlocked
pure def lockPhotos(s: PhotoRead): PhotoRead = {...s, unlocked: false, epoch: s.epoch + 1}
pure def canUnlockPhotos(s: PhotoRead): bool = not(s.unlocked)
pure def unlockPhotos(s: PhotoRead): PhotoRead = {...s, unlocked: true}
pure def canClosePhotos(s: PhotoRead): bool = not(s.closed)
pure def closePhotos(s: PhotoRead): PhotoRead = {...s, closed: true, epoch: s.epoch + 1}
pure def alwaysPhotoCoordinatesValid(s: PhotoRead): bool =
  s.epoch >= 0 and s.actualAccess >= 0 and s.ticket <= s.epoch
pure def alwaysPhotoResultOwnsTicket(s: PhotoRead): bool =
  s.phase == PhotoPublished implies s.publishedEpoch == s.ticket and s.ticket >= 0
pure def stepPhotoPublicationChecksCurrentScope(before: PhotoRead, via: str, after: PhotoRead): bool =
  via == "publishPhotoRead" and after.phase == PhotoPublished implies effectivePhotoTicket(before)
pure def sometimesPhotoReadPublishes(s: PhotoRead): bool = s.phase == PhotoPublished
pure def sometimesOldPhotoReadRefused(s: PhotoRead): bool =
  s.phase == PhotoRefused and s.ticket >= 0 and s.ticket < s.epoch
```
