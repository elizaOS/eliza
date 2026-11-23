# Device surfaces in chat

The [proposal path](./index.md) turns an owner's chat request into one
device request, and each operation family grounds what the model proposed
in the owner's own words and screen before anything is offered. This family
covers the phone's own surfaces: a photo taken with the camera, the Photos
library and viewer, opening an app view, reading the place or route selected
in Maps, and a new text note in the phone's own Notes. Its forms follow the
request's [negotiation](./capabilities.md) and each operation's
[need](./operations.md); which of them may run without a review is the
operations' rule, and the review itself is [execution](./execution.md)'s.

## Story: Propose a photo, a view, a Maps read or a Photos change only as my words and my screen name them

> As the owner, I want "take a picture", "show my Files", "how far is this
> place?", "share this photo" or a note in the phone's Notes to become one
> request my phone runs or reviews, aimed only at what I asked for or have
> open, so that the agent never takes a photo without my card unless I
> asked for one, reads a place I did not select or names a photo it guessed.

### A surface operation is bound to the owner's message only on a direct-request turn and as the owner asked

An operation of this family that may run without a review (a photo, a grid
filter or an opened item in Photos, selected library photos, a new note or
an opened view) runs directly only when the proposal carries the owner's
message. It carries it only when the owner's message states the
direct-request preference (`agentActionMode` `direct-request-v1` in its
[voice view context](../conversation/turnContext.md)) and the family
grounded the operation as the owner asked; anything else is
[grounded for review](./index.md), so the phone shows its card.

```quint
type SurfaceVerdict = SurfaceGrounded | SurfaceReviewed | SurfaceRefused
pure def surfaceBound(directRequests: bool, verdict: SurfaceVerdict): bool = directRequests and verdict == SurfaceGrounded
pure def lawWithoutDirectRequestsNothingIsBound(verdict: SurfaceVerdict): bool = not(surfaceBound(false, verdict))
pure def lawAReviewedSurfaceIsNeverBound(directRequests: bool): bool = not(surfaceBound(directRequests, SurfaceReviewed))
```

### A photo runs without its card only when the owner's own message asks for one now

The owner's message, as the host stored it and without any document
wrapper, asks for a photo now when the whole message is a command to take,
snap, shoot or capture a picture, photo, photograph, pic, snapshot or
selfie, optionally greeted ("hey", "ok"), addressed to the assistant by
name, with "please", "quick", "of me", a named camera, "now" or "thanks",
or the same command asked as "can, could, would or will you (please) …?".
A message that asks for a selfie or a photo of the owner with the back,
rear or main camera, that is longer than 512 characters or holds a control
character, or that is any other phrasing ("don't take a photo", "did you
take a photo?", "take a photo of the whiteboard", "summarize the page I
have open") does not. A capture for any other message is still proposed,
grounded for review, so the owner gets the phone's Take photo card; a
capture is never refused for its words. A second capture in the same turn,
grounded the same way, is that same request ([proposal identity](./index.md)).
The capture names no lens: the [camera](../../os/android/camera.md) has no
lens capability, so the phone uses the camera that is showing.

```quint
type CameraWords = { units: int, hasControl: bool, commanded: bool, front: bool, back: bool }
pure val cameraWordsMaxUnits = 512
pure val wordsValues = Set(
  { units: 10, hasControl: false, commanded: true, front: false, back: false },
  { units: 513, hasControl: false, commanded: true, front: false, back: false },
  { units: 10, hasControl: true, commanded: true, front: false, back: false },
  { units: 10, hasControl: false, commanded: false, front: false, back: false },
  { units: 10, hasControl: false, commanded: true, front: true, back: true })
pure def asksForPhotoNow(words: CameraWords): bool =
  words.units <= cameraWordsMaxUnits and not(words.hasControl) and words.commanded and not(words.front and words.back)
pure def captureVerdict(words: CameraWords): SurfaceVerdict = if (asksForPhotoNow(words)) SurfaceGrounded else SurfaceReviewed
pure def lawACaptureIsNeverRefused(words: CameraWords): bool = captureVerdict(words) != SurfaceRefused
pure def lawAPhotoNobodyAskedForKeepsItsCard(words: CameraWords): bool = not(words.commanded) implies captureVerdict(words) == SurfaceReviewed
pure def lawALongOrControlMessageAsksForNoPhoto(words: CameraWords): bool =
  (words.units > cameraWordsMaxUnits or words.hasControl) implies not(asksForPhotoNow(words))
pure def lawAFrontAndBackCameraAsksForNoPhoto(words: CameraWords): bool = (words.front and words.back) implies not(asksForPhotoNow(words))
```

### An app view is offered only without completed-action navigation, and proposed only when the installation's profile enables it

When the turn's voice view context says views arrive as completed actions,
the model opens a view with `VIEWS` directly and is never offered
`open_view`, which would ask the phone for a review it does not need; one
proposed anyway is not an offered form. Otherwise a view is proposed only
when the installation's [enabled-view profile](./capabilities.md) as it is
now enables it, and the proposal binds that profile's revision. When the
installation has a profile, the model is told which views it enables.

```quint
pure def openViewOffered(completedNavigation: bool): bool = not(completedNavigation)
pure def openViewVerdict(profileEnables: bool): SurfaceVerdict = if (profileEnables) SurfaceGrounded else SurfaceRefused
pure def lawCompletedNavigationOffersNoView(completedNavigation: bool): bool = completedNavigation implies not(openViewOffered(completedNavigation))
pure def lawADisabledViewIsNeverProposed(profileEnables: bool): bool = not(profileEnables) implies openViewVerdict(profileEnables) == SurfaceRefused
```

### A new note is offered only while the owner's Notes screen selects the phone's own Notes

`create_note` writes to the phone's own Notes store, so it is offered only
when the turn's observation shows the Notes view on a screen that is not
sensitive with a phone note source (`note-source`, its ID and revision) or
a phone note (`note`, with its account, source revision, ID and revision)
selected, each of a valid form. On any other turn, including one with no
observation or a canonical Notes selection, a note request belongs to the
canonical Notes service and the model is told so.

```quint
pure def noteOffered(notesView: bool, sensitive: bool, phoneNotesSelected: bool): bool = notesView and not(sensitive) and phoneNotesSelected
pure def lawANoteNeedsThePhoneNotesSelected(notesView: bool, sensitive: bool, phoneNotesSelected: bool): bool =
  noteOffered(notesView, sensitive, phoneNotesSelected) implies (notesView and phoneNotesSelected)
pure def lawASensitiveScreenOffersNoNote(notesView: bool, phoneNotesSelected: bool): bool = not(noteOffered(notesView, true, phoneNotesSelected))
```

### A Maps read names exactly the place or route selected on the owner's Maps screen

The turn's [observation](../conversation/turnContext.md) must show the
Maps view on a screen that is not sensitive, with a selected place or
route that carries nothing beyond its kind, ID and revision, and the
proposed target must be exactly that kind, ID and revision. Anything else,
including a turn with no observation, is refused: the agent never infers a
place from an opaque ID or from an earlier turn.

```quint
pure def mapsVerdict(mapsView: bool, sensitive: bool, extraFields: bool, sameTarget: bool): SurfaceVerdict =
  if (mapsView and not(sensitive) and not(extraFields) and sameTarget) SurfaceGrounded else SurfaceRefused
pure def lawAMapsReadNeedsTheSelectionOnScreen(mapsView: bool, sensitive: bool, extraFields: bool, sameTarget: bool): bool =
  mapsVerdict(mapsView, sensitive, extraFields, sameTarget) == SurfaceGrounded implies (mapsView and not(sensitive) and sameTarget)
pure def lawASensitiveScreenReadsNoPlace(mapsView: bool, extraFields: bool, sameTarget: bool): bool =
  mapsVerdict(mapsView, true, extraFields, sameTarget) == SurfaceRefused
```

### A Photos proposal names only the item open in the viewer or library IDs the phone returned

An album or share that names the open item (`selected`) is proposed only
when the turn's observation [targets the open photo](./operations.md). An
operation that names library IDs (open, inspect, select, review, or an
album or share by IDs) is proposed only when every ID is one the phone
returned in this conversation, an applied library search or inspection or
a saved photo's library ID, or the library ID of the item the turn's
observation selects in the Photos view on a screen that is not sensitive,
however an album or share would name that item. A review names each item's
revision as that search or inspection returned it. A search or a grid
filter names no photo. Anything else is refused, so a guessed ID never
reaches the phone.

```quint
type PhotoNaming = NoPhotoNamed | OpenItemNamed | LibraryIdsNamed
pure def photosVerdict(naming: PhotoNaming, openItemShown: bool, idsReturned: bool): SurfaceVerdict =
  if (naming == OpenItemNamed) (if (openItemShown) SurfaceGrounded else SurfaceRefused)
  else if (naming == LibraryIdsNamed) (if (idsReturned) SurfaceGrounded else SurfaceRefused)
  else SurfaceGrounded
pure def lawTheOpenItemIsNamedOnlyWhileShown(idsReturned: bool): bool = photosVerdict(OpenItemNamed, false, idsReturned) == SurfaceRefused
pure def lawAGuessedLibraryIdIsNeverProposed(openItemShown: bool): bool = photosVerdict(LibraryIdsNamed, openItemShown, false) == SurfaceRefused
pure def lawASearchNamesNoPhoto(openItemShown: bool, idsReturned: bool): bool = photosVerdict(NoPhotoNamed, openItemShown, idsReturned) == SurfaceGrounded
```
