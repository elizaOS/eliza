# Alpha native storage observer custody

Alpha's native `AlphaFilesPlugin.java` uses the producer's
`StorageBrowser.WatchSlot` from
`plugins/plugin-native-filesystem/android/src/main/java/ai/eliza/plugins/filesystem/browser/StorageBrowser.java`.
The pinned `StorageWatch.qnt` compares three ticket generations.
The runtime can issue an arbitrary number. This projection models
one current resource, its ticket and its observable results. Android
file-observer and media-observer registration and unregistering remain
host effects.

## Story: Replace a folder watch without publishing from a retired callback

### Only the newest successful registration owns the watch slot

Issuing a request retires publication from the old ticket immediately.
The previous resource may still be allocated until the current
request installs its watch or fails. The latest refusal stops the
old resource. A stale refusal does not stop a newer watch. Explicit
unwatch increments the ticket and releases the resource.
The producer serializes all of those changes with installation under
the slot lock.

```quint
type WatchSlot = { generation: int, activeTicket: int, refused: bool, releases: int, emitted: int }
pure val initial: WatchSlot = {generation: 0, activeTicket: 0, refused: false, releases: 0, emitted: 0}
pure def requestWatch(w: WatchSlot): WatchSlot =
  {...w, generation: w.generation + 1, refused: false}
pure def canInstallWatch(w: WatchSlot, ticket: int): bool =
  ticket > 0 and ticket == w.generation and ticket != w.activeTicket
pure def installWatch(w: WatchSlot, ticket: int): WatchSlot =
  {...w, activeTicket: ticket, refused: false, releases: w.releases + (if (w.activeTicket > 0) 1 else 0)}
pure def refuseWatch(w: WatchSlot, ticket: int): WatchSlot =
  if (ticket > 0 and ticket == w.generation) {
    ...w, activeTicket: 0, refused: true, releases: w.releases + (if (w.activeTicket > 0) 1 else 0)
  } else w
pure def unwatch(w: WatchSlot): WatchSlot =
  {...w, generation: w.generation + 1, activeTicket: 0, refused: false, releases: w.releases + (if (w.activeTicket > 0) 1 else 0)}
pure def canPublishObservation(w: WatchSlot, ticket: int): bool =
  ticket > 0 and w.activeTicket == ticket and w.generation == ticket
pure def publishObservation(w: WatchSlot, ticket: int): WatchSlot = {...w, emitted: w.emitted + 1}
pure val ticketValues = Set(0, 1, 2, 3)
pure def alwaysLatestOwnsPublication(w: WatchSlot): bool =
  w.generation >= 0 and w.activeTicket >= 0 and w.activeTicket <= w.generation and (w.refused implies w.activeTicket == 0)
pure def alwaysObservationCountsValid(w: WatchSlot): bool = w.releases >= 0 and w.emitted >= 0
pure def stepOnlyCurrentWatchPublishes(before: WatchSlot, via: str, after: WatchSlot): bool =
  after.emitted > before.emitted implies via == "publishObservation" and before.activeTicket > 0 and before.activeTicket == before.generation
pure def sometimesRetiredWatchAwaitsRelease(w: WatchSlot): bool = w.activeTicket > 0 and w.activeTicket < w.generation
pure def sometimesRefusalReleasesWatch(w: WatchSlot): bool = w.refused and w.releases > 0
pure def sometimesWatchPublishes(w: WatchSlot): bool = w.emitted > 0
```
