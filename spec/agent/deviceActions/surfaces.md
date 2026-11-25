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

A capture that carries the message is answered as the handoff it is: the
owner hears "Opening Camera to take the photo." and the model learns that
the phone takes it right after the reply, with no review, and that no photo
has been taken yet. Every other pending request of this family asks the
owner to review it on the phone. A request that already settled is answered
by the model from its stored result, which is historical and never a current
read; the family adds no sentence of its own.

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
A message that asks for both lenses, that is longer than 512 characters or
holds a control character, or that is any other phrasing ("don't take a
photo", "did you take a photo?", "take a photo of the whiteboard",
"summarize the page I have open") does not. Outside the lens refusals below,
a capture without a named lens for any other message is grounded for review,
so the owner gets the phone's Take photo card. A second capture in the same turn,
grounded the same way, is that same request ([proposal identity](./index.md)),
so one message takes one photo; a photo asked for again in a later message is
a request of its own, since a capture that runs without its card runs only
for the message that asked for it.

Whether a message asks for a photo at all is the model's to judge: the
device tool's description says that the capture is how a picture, photo
or selfie is taken and that showing Camera with `VIEWS` takes none, and a
photo request is planned like any other message. Nothing proposes the
capture before the model's choice, and no call is refused for the words of
a photo request; the words above only decide whether a capture the model
proposed may skip its card and which lens it may use.

```quint
type CameraWords = { units: int, hasControl: bool, commanded: bool, front: bool, back: bool }
pure val cameraWordsMaxUnits = 512
pure def asksForPhotoNow(words: CameraWords): bool =
  words.units <= cameraWordsMaxUnits and not(words.hasControl) and words.commanded and not(words.front and words.back)
pure def captureVerdict(words: CameraWords): SurfaceVerdict = if (asksForPhotoNow(words)) SurfaceGrounded else SurfaceReviewed
pure def lawACaptureIsNeverRefused(words: CameraWords): bool = captureVerdict(words) != SurfaceRefused
pure def lawAPhotoNobodyAskedForKeepsItsCard(words: CameraWords): bool = not(words.commanded) implies captureVerdict(words) == SurfaceReviewed
pure def lawALongOrControlMessageAsksForNoPhoto(words: CameraWords): bool =
  (words.units > cameraWordsMaxUnits or words.hasControl) implies not(asksForPhotoNow(words))
pure def lawAFrontAndBackCameraAsksForNoPhoto(words: CameraWords): bool = (words.front and words.back) implies not(asksForPhotoNow(words))
pure val wordsValues = Set(
  { units: 13, hasControl: false, commanded: true, front: false, back: false },
  { units: 40, hasControl: false, commanded: false, front: false, back: false },
  { units: 513, hasControl: false, commanded: true, front: false, back: false },
  { units: 512, hasControl: false, commanded: true, front: false, back: true },
  { units: 14, hasControl: true, commanded: true, front: false, back: false },
  { units: 15, hasControl: false, commanded: true, front: true, back: false },
  { units: 45, hasControl: false, commanded: true, front: true, back: true })
```

### A named camera is captured only as the owner requested and the phone supports

Which lens a photo uses is the model's to read from the owner's request:
lens front for a selfie or the front camera, lens back for the back, rear
or main camera, and no lens for the camera that is showing. A named
capture needs the owner's own chat and the negotiated
`camera.capture-lens.v1` capability. Without them, the tool asks the model
to explain the limitation and offers no capture. A capture skips its card
only when the owner's whole-message command above names that same camera:
the front lens for a selfie or the front camera, the back lens for the
back, rear or main camera, and no lens when it names none. Every other
capture, a lens the command did not name, an unnamed capture after a
command that named one, or a lens chosen where the owner asked for both,
keeps its review card, which names the lens it will use, so a lens the
command words miss is never refused for them.

```quint
type CameraChoice = ShowingCamera | FrontCamera | BackCamera | ConflictingCameras
pure def requestedCamera(words: CameraWords): CameraChoice =
  if (words.commanded and words.front and words.back) ConflictingCameras
  else if (asksForPhotoNow(words) and words.front) FrontCamera
  else if (asksForPhotoNow(words) and words.back) BackCamera
  else ShowingCamera
pure val chosenCameraValues = Set(ShowingCamera, FrontCamera, BackCamera, ConflictingCameras)
pure def captureLensVerdict(words: CameraWords, namedLensAvailable: bool, chosenCamera: CameraChoice): SurfaceVerdict =
  if (chosenCamera == ConflictingCameras or (chosenCamera != ShowingCamera and not(namedLensAvailable))) SurfaceRefused
  else if (requestedCamera(words) == chosenCamera) captureVerdict(words)
  else SurfaceReviewed
pure def lawANamedCaptureNeedsTheLensCapability(words: CameraWords, chosenCamera: CameraChoice): bool =
  chosenCamera != ShowingCamera implies captureLensVerdict(words, false, chosenCamera) == SurfaceRefused
pure def lawOnlyTheCommandedCameraSkipsItsCard(words: CameraWords, namedLensAvailable: bool, chosenCamera: CameraChoice): bool =
  captureLensVerdict(words, namedLensAvailable, chosenCamera) == SurfaceGrounded
    implies (asksForPhotoNow(words) and requestedCamera(words) == chosenCamera)
pure def lawAnUnnamedCaptureDoesNotSubstituteForAnotherLensWithoutItsCard(words: CameraWords, namedLensAvailable: bool): bool =
  (requestedCamera(words) != ShowingCamera) implies captureLensVerdict(words, namedLensAvailable, ShowingCamera) == SurfaceReviewed
pure def lawTheOwnersWordsNeverRefuseALensThePhoneOffers(words: CameraWords, chosenCamera: CameraChoice): bool =
  chosenCamera != ConflictingCameras implies captureLensVerdict(words, true, chosenCamera) != SurfaceRefused
```

### An app view opens with VIEWS where views arrive as completed actions, else with open_view as the installation's profile enables it

How views are delivered is stated anew with each message: the phone leaves
it out while its screen is sensitive. So a device conversation's tools keep
both homes of a view, `VIEWS` and, where the device negotiated it, the
`open_view` form, and each message opens a view in one of them. When the
message's voice view context says views arrive as completed actions, the
model opens a view with `VIEWS` directly, and `open_view`, which would ask
the phone for a review it does not need, is refused before dispatch.
Otherwise a `VIEWS` call is refused before it runs, and a view is proposed
with `open_view` only when the installation's
[enabled-view profile](./capabilities.md) as it is now enables it, and
the proposal binds that profile's revision. Either refusal is of a call
the message serves in the other place
([planning](../conversation/planning.md)): the model reads where, and the
owner hears no failure for it, so a message whose model tried the wrong
home first and then the right one reports only the right one. The device
tool's note tells the model which of the two serves the message. When the
installation has a profile and the device negotiated `open_view`, the
model is told which views it enables.

```quint
type ViewHome = ViewsShows | OpenViewProposes
pure def viewHome(completedNavigation: bool): ViewHome = if (completedNavigation) ViewsShows else OpenViewProposes
pure def openViewAvailable(completedNavigation: bool): bool = viewHome(completedNavigation) == OpenViewProposes
pure def viewsShowsOnDevice(completedNavigation: bool): bool = viewHome(completedNavigation) == ViewsShows
pure def openViewVerdict(profileEnables: bool): SurfaceVerdict = if (profileEnables) SurfaceGrounded else SurfaceRefused
pure def lawCompletedNavigationProposesNoView(completedNavigation: bool): bool = completedNavigation implies not(openViewAvailable(completedNavigation))
pure def lawAMessageOpensAViewInOnePlace(completedNavigation: bool): bool =
  viewsShowsOnDevice(completedNavigation) != openViewAvailable(completedNavigation)
pure def lawADisabledViewIsNeverProposed(profileEnables: bool): bool = not(profileEnables) implies openViewVerdict(profileEnables) == SurfaceRefused
```

### A new note is proposed only while the owner's Notes screen selects the phone's own Notes

`create_note` writes to the phone's own Notes store, so it is available
only on a message whose observation shows the Notes view on a screen that
is not sensitive with a phone note source (`note-source`, its ID and
revision) or a phone note (`note`, with its account, source revision, ID
and revision) selected, each of a valid form. The form is offered whenever
the device negotiated it, and a `create_note` on any other message,
including one with no observation or a canonical Notes selection, is
refused before dispatch as a call the message serves elsewhere: the note
request belongs to the canonical Notes service. The device tool's
description says so whenever the form is offered, the tool's note on such
a message says only that the form is not available on it, and the refusal
says where the request belongs. A device that did not negotiate it has the
family's guidance say so instead.

```quint
pure def noteAvailable(notesView: bool, sensitive: bool, phoneNotesSelected: bool): bool = notesView and not(sensitive) and phoneNotesSelected
pure def lawANoteNeedsThePhoneNotesSelected(notesView: bool, sensitive: bool, phoneNotesSelected: bool): bool =
  noteAvailable(notesView, sensitive, phoneNotesSelected) implies (notesView and phoneNotesSelected)
pure def lawASensitiveScreenProposesNoNote(notesView: bool, phoneNotesSelected: bool): bool = not(noteAvailable(notesView, true, phoneNotesSelected))
```

### A new note runs without its card only when its title and body are the owner's own words

The phone writes the note's title and body as the model proposed them. A
note is grounded as the owner asked only when its title and its body each
appear in the owner's message, ignoring case, runs of spaces and a final
full stop, exclamation or question mark; so a note whose text the model
took from a page, an email or a summary of its own is grounded for review,
and the owner reads it on the phone's card before it is saved. A note is
never refused for its words.

```quint
pure def noteVerdict(ownerWords: bool): SurfaceVerdict = if (ownerWords) SurfaceGrounded else SurfaceReviewed
pure def lawANoteTheOwnerDidNotSayKeepsItsCard(directRequests: bool): bool = not(surfaceBound(directRequests, noteVerdict(false)))
pure def lawANoteIsNeverRefusedForItsWords(ownerWords: bool): bool = noteVerdict(ownerWords) != SurfaceRefused
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
