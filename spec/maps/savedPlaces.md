# Maps saved places on the phone

The phone keeps the owner's saved places: a label, a coordinate and, for a
provider place, the provider's identity. It keeps no cached provider details
and no location history. The agent may read the list through a read-only
port; only the owner's Maps screen changes it. The assistant keeps its own
saved places for the owner, which the agent writes only through a save the
owner asked for.

## Story: Keep my saved places safe on this phone

> As the owner, I want a saved place kept exactly as I saved it, and a list
> the phone cannot read never replaced by a shorter one.

### A saved list is changed only when it reads back, and a change counts only once it is confirmed

A save, rename or removal first reads the whole list. A list that cannot be
read, or that is not a valid list, is never written over: the owner is told
and the stored data stays as it was. A list holds at most 200 places, so a
new place needs room while saving an existing one again replaces it in
place. A change is reported done only after the stored list reads back as
written.

```quint
type SavedWrite = { readable: bool, existing: bool, count: int, confirmed: bool }
pure val savedPlacesLimit = 200
pure def maySaveTo(w: SavedWrite): bool = w.readable and (w.existing or w.count < savedPlacesLimit)
pure def savedChangeDone(w: SavedWrite): bool = maySaveTo(w) and w.confirmed
pure val wValues = Set({ readable: true, existing: false, count: 199, confirmed: true }, { readable: true, existing: false, count: 200, confirmed: true },
  { readable: true, existing: true, count: 200, confirmed: true }, { readable: false, existing: false, count: 0, confirmed: true },
  { readable: true, existing: false, count: 3, confirmed: false })
pure def lawUnreadableListIsNeverReplaced(w: SavedWrite): bool = not(w.readable) implies not(maySaveTo(w))
pure def lawFullListTakesNoNewPlace(w: SavedWrite): bool = (not(w.existing) and w.count >= savedPlacesLimit) implies not(maySaveTo(w))
pure def lawUnconfirmedChangeIsNotDone(w: SavedWrite): bool = not(w.confirmed) implies not(savedChangeDone(w))
```

## Story: Save a place with my assistant once

> As the owner, I want "save this as Work" kept once with my assistant, a
> repeated request not to save it twice, and an old request never to undo a
> later change.

### A save under a known key repeats its first outcome, and only a new change writes

A save names an idempotency key, or one is derived from the place and the
label. A key already used for a different place or label is refused. A
repeat of a key the owner gave, or of a derived key whose save is still the
current state, repeats the first outcome and writes nothing; a derived key
whose save a later change superseded ("change it back to Work") is a new
change. An owner keeps at most 64 places and 256 recorded changes. A change
is reported done only after it is committed against the revision it read;
a repeat is reported as already saved, and a superseded repeat names the
current label instead of claiming success.

```quint
type SaveCourse = ApplySave | ReplaySave | RefuseKeyReuse | RefuseFull
type SaveRequest = { known: bool, sameRequest: bool, explicitKey: bool, currentlyApplied: bool, existingPlace: bool, places: int, changes: int }
pure val agentPlacesLimit = 64
pure val agentChangesLimit = 256
pure def saveCourse(r: SaveRequest): SaveCourse =
  if (r.known and not(r.sameRequest)) RefuseKeyReuse
  else if (r.known and (r.explicitKey or r.currentlyApplied)) ReplaySave
  else if (r.changes >= agentChangesLimit or (not(r.existingPlace) and r.places >= agentPlacesLimit)) RefuseFull
  else ApplySave
pure def saveCommitted(course: SaveCourse, revisionUnchanged: bool): bool = course == ApplySave and revisionUnchanged
pure val rValues = Set({ known: false, sameRequest: true, explicitKey: false, currentlyApplied: false, existingPlace: false, places: 3, changes: 3 },
  { known: true, sameRequest: true, explicitKey: true, currentlyApplied: false, existingPlace: true, places: 3, changes: 3 },
  { known: true, sameRequest: true, explicitKey: false, currentlyApplied: false, existingPlace: true, places: 3, changes: 3 },
  { known: true, sameRequest: false, explicitKey: true, currentlyApplied: true, existingPlace: true, places: 3, changes: 3 },
  { known: false, sameRequest: true, explicitKey: false, currentlyApplied: false, existingPlace: false, places: 64, changes: 3 })
pure def lawKeyReuseIsRefused(r: SaveRequest): bool = (r.known and not(r.sameRequest)) implies saveCourse(r) == RefuseKeyReuse
pure def lawReplayWritesNothing(r: SaveRequest, revisionUnchanged: bool): bool = saveCourse(r) == ReplaySave implies not(saveCommitted(saveCourse(r), revisionUnchanged))
pure def lawSupersededDerivedSaveIsANewChange(r: SaveRequest): bool =
  (r.known and r.sameRequest and not(r.explicitKey) and not(r.currentlyApplied)) implies saveCourse(r) != ReplaySave
pure def lawFullOwnerAddsNoPlace(r: SaveRequest): bool =
  (not(r.known) and not(r.existingPlace) and r.places >= agentPlacesLimit) implies saveCourse(r) == RefuseFull
```

### A destination may be a place saved with the assistant, or coordinates the owner names

Directions from here and a route between places take their destination
as a place saved with the assistant, by its id in the saved list; as a
provider place the owner chose; as coordinates, shown under the name the
owner gave or the coordinates themselves; or by name. A saved id comes
first and is never replaced by another reading: one that is no longer in
the list is said, and nothing else is looked up. Coordinates outside the
valid range are refused. The saved list names only the places saved with
the assistant and says that places kept only on the phone's Maps screen
are not included.

```quint
type DestinationSource = FromSavedPlace | FromPlaceId | FromCoordinates | FromName | NoDestination
pure def destinationSource(savedId: bool, placeId: bool, point: bool, named: bool): DestinationSource =
  if (savedId) FromSavedPlace else if (placeId) FromPlaceId else if (point) FromCoordinates else if (named) FromName else NoDestination
pure def lawASavedIdIsNeverReadAnotherWay(placeId: bool, point: bool, named: bool): bool =
  destinationSource(true, placeId, point, named) == FromSavedPlace
pure def lawNothingGivenIsNoDestination(savedId: bool): bool = (destinationSource(savedId, false, false, false) == NoDestination) iff not(savedId)
```
