# Device surfaces in chat

The [proposal path](./index.md) turns an owner's chat request into one
device request, and each operation family grounds what the model proposed
in the owner's own words and screen before anything is offered. This family
covers the phone's own surfaces: a photo taken with the camera, the Photos
library and viewer, opening an app view, reading the place or route selected
in Maps, and a new text note. Its forms follow the request's
[negotiation](./capabilities.md) and each operation's
[need](./operations.md); which of them may run without a review is the
operations' rule, and the review itself is [execution](./execution.md)'s.

A note the owner dictates is offered as the model wrote it: it names no
person, record or place, and it is reviewed or run as the owner allows.

## Story: Propose a photo, a view, a Maps read or a Photos change only as my words and my screen name them

> As the owner, I want "take a picture", "show my Files", "how far is this
> place?" or "share this photo" to become one request my phone runs or
> reviews, aimed only at what I asked for or have open, so that the agent
> never takes a photo I did not ask for, reads a place I did not select or
> names a photo it guessed.

### A photo is proposed only when the owner's own message asks for one now

The owner's message, as the host stored it and without any document
wrapper, asks for a photo now when the whole message is a command to take,
snap, shoot or capture a picture, photo, photograph, pic, snapshot or
selfie, optionally greeted ("hey", "ok"), addressed to the assistant by
name, with "please", "quick", "of me", a named camera, "now" or "thanks",
or the same command asked as "can, could, would or will you (please) …?".
A message that names both the front and the back camera, that is longer
than 512 characters or holds a control character, or that is any other
phrasing ("don't take a photo", "did you take a photo?", "take a photo in
five minutes", "summarize the page I have open") does not. Only such a
message has a capture proposed; any other capture is refused before
anything is kept, because every chat proposal is bound to the owner's
message and the phone may then run a photo without its card. A second
capture in the same turn is that same request ([proposal
identity](./index.md)). The capture names no lens: the [camera](../../os/android/camera.md)
has no lens capability, so the phone uses the camera that is showing.

```quint
type SurfaceVerdict = SurfaceGrounded | SurfaceRefused
pure def captureVerdict(asksNow: bool): SurfaceVerdict = if (asksNow) SurfaceGrounded else SurfaceRefused
pure def lawAPhotoNobodyAskedForIsNeverProposed(asksNow: bool): bool = not(asksNow) implies captureVerdict(asksNow) == SurfaceRefused
pure def lawAPhotoAskedForNowIsProposed(asksNow: bool): bool = asksNow implies captureVerdict(asksNow) == SurfaceGrounded
```

### An app view is offered only without completed-action navigation, and proposed only when the installation's profile enables it

When the turn's voice view context says views arrive as completed actions,
the model opens a view with `VIEWS` directly and is never offered
`open_view`, which would ask the phone for a review it does not need; one
proposed anyway is refused. Otherwise a view is proposed only when the
installation's [enabled-view profile](./capabilities.md) as it is now
enables it, and the proposal binds that profile's revision.

```quint
pure def openViewOffered(completedNavigation: bool): bool = not(completedNavigation)
pure def openViewVerdict(completedNavigation: bool, profileEnables: bool): SurfaceVerdict =
  if (openViewOffered(completedNavigation) and profileEnables) SurfaceGrounded else SurfaceRefused
pure def lawCompletedNavigationProposesNoView(profileEnables: bool): bool = openViewVerdict(true, profileEnables) == SurfaceRefused
pure def lawADisabledViewIsNeverProposed(completedNavigation: bool): bool = openViewVerdict(completedNavigation, false) == SurfaceRefused
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
returned in this conversation: an applied library search or inspection, a
saved photo's library ID, or the open item's library ID that the turn's
observation names. A review names each item's revision as that search or
inspection returned it. A search or a grid filter names no photo. Anything
else is refused, so a guessed ID never reaches the phone.

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
