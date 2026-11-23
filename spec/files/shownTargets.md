# Files shown targets

The agent may name files by their position in the filter results Files
shows instead of by path. Which forms the agent is offered follows what the
peer negotiated, and the phone resolves every position to an exact path
before the owner reviews the card, so the owner reviews the actual files and
the agent never learns a name it was not given. [Reviewed file
identity](./reviewPin.md) pins what the card showed; [reviewed
operations](./reviewedOperations.md) act on it.

## Story: Name what Files shows without leaking or guessing a file

> As the owner, I want to say "share the first one" about what Files shows
> me, review the actual files before anything happens, and have nothing
> happen when the phone cannot tell which files I meant.

### Files operations need files.browser.v1, and a shown share, move or trash also needs files.shown-target.v1

Every Files operation is offered to and admitted from a peer only when it
negotiated `files.browser.v1`. Opening a shown position is part of that
capability. A share, move or trash that names shown positions is offered and
admitted only when the peer also negotiated `files.shown-target.v1`; a
filter and a new folder never name positions.

```quint
type FilesKind = FilterKind | OpenKind | ShareKind | MoveKind | TrashKind | FolderCreateKind
type FilesForm = PathForm | ShownForm
pure def changesShown(kind: FilesKind): bool = kind == ShareKind or kind == MoveKind or kind == TrashKind
pure def formAdmitted(kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): bool =
  browserNegotiated and (form == PathForm or kind == OpenKind or (changesShown(kind) and shownNegotiated))
pure def lawNothingWithoutTheBrowserCapability(kind: FilesKind, form: FilesForm, shownNegotiated: bool): bool =
  not(formAdmitted(kind, form, false, shownNegotiated))
pure def lawUnnegotiatedShownChangeIsRefused(kind: FilesKind): bool =
  changesShown(kind) implies not(formAdmitted(kind, ShownForm, true, false))
pure def lawPathFormNeedsOnlyTheBrowserCapability(kind: FilesKind): bool = formAdmitted(kind, PathForm, true, false)
pure def lawFilterAndFolderNeverNamePositions(browserNegotiated: bool, shownNegotiated: bool): bool =
  not(formAdmitted(FilterKind, ShownForm, browserNegotiated, shownNegotiated)) and
    not(formAdmitted(FolderCreateKind, ShownForm, browserNegotiated, shownNegotiated))
```

### A Files operation the owner asks for in chat is proposed only within the Files bounds and as the peer negotiated it

When the model proposes a Files operation from the owner's chat request,
it is read by these Files bounds: paths relative to Internal storage, each
named once, and a new folder whose name is not hidden. It is proposed only
when its kind and form are admitted for the peer that sent the turn;
otherwise nothing is kept and the owner is told it could not be prepared.
A move or trash keeps no identity the model sent, since the phone reads
each one when it builds the card. The model is told to name only paths the
owner said or positions Files showed, and that a share, move, trash or new
folder is reviewed with Files on screen.

```quint
pure def chatProposalKept(withinBounds: bool, kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): bool =
  withinBounds and formAdmitted(kind, form, browserNegotiated, shownNegotiated)
pure def lawOutOfBoundsIsNeverProposed(kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): bool =
  not(chatProposalKept(false, kind, form, browserNegotiated, shownNegotiated))
pure def lawAProposedFormIsAdmitted(withinBounds: bool, kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): bool =
  chatProposalKept(withinBounds, kind, form, browserNegotiated, shownNegotiated) implies formAdmitted(kind, form, browserNegotiated, shownNegotiated)
```

### A card for shown positions exists only when every position resolved to one path, and it executes those paths

The phone resolves the positions against the filter results it shows now,
one path for each position, in order. When Files shows no filter results,
a position shows nothing, or fewer paths come back than positions were
named, there is no card: the owner is told the files are not in Files. The
reviewed operation names the resolved paths, never positions, so approval
executes exactly what the card showed.

```quint
type ShownResolution = { positions: int, resolvedPaths: int, resultsShown: bool }
pure def shownResolved(r: ShownResolution): bool = r.resultsShown and r.positions >= 1 and r.resolvedPaths == r.positions
pure def cardShown(form: FilesForm, r: ShownResolution): bool = form == PathForm or shownResolved(r)
pure val rValues = Set({ positions: 2, resolvedPaths: 2, resultsShown: true }, { positions: 2, resolvedPaths: 1, resultsShown: true },
  { positions: 1, resolvedPaths: 1, resultsShown: false }, { positions: 0, resolvedPaths: 0, resultsShown: true })
pure def lawUnresolvedPositionsShowNoCard(r: ShownResolution): bool =
  not(shownResolved(r)) implies not(cardShown(ShownForm, r))
pure def lawPathCardNeedsNoResolution(r: ShownResolution): bool = cardShown(PathForm, r)
```

### A move or trash binds the identity of each reviewed file, and a share binds none

A move or trash carries the storage identity the phone read for each path
when it built the card, replacing anything the agent sent, and a card that
cannot read every identity is not shown. A share hands the files to another
app as they are now and carries no identities.

```quint
pure def bindsIdentity(kind: FilesKind): bool = kind == MoveKind or kind == TrashKind
pure def identitiesReady(kind: FilesKind, paths: int, identities: int): bool =
  if (bindsIdentity(kind)) identities == paths and paths >= 1 else identities == 0
pure def lawShareBindsNoIdentity(paths: int, identities: int): bool =
  identitiesReady(ShareKind, paths, identities) implies identities == 0
pure def lawMoveAndTrashBindEveryPath(kind: FilesKind, paths: int, identities: int): bool =
  (bindsIdentity(kind) and identitiesReady(kind, paths, identities)) implies identities == paths
```
