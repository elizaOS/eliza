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

### A Files operation the owner asks for in chat is proposed within the Files bounds as the peer negotiated it, wherever the owner is

When the model proposes a Files operation from the owner's chat request,
the Files decoder reads it by these Files bounds: paths relative to Internal
storage, each named once, and a new folder whose name is not hidden; one
outside them is refused with the bound it broke and never reaches the rule
below. It is proposed only when its kind and form are admitted for the peer
that sent the turn; a form the peer did not negotiate is refused as such.
What the owner's screen shows does not decide whether it is proposed: a
request made from Home, or from a turn that carries no observation, becomes
the request, and the phone's card waits for the owner to open Files (next
rule). A move or trash keeps no identity the model sent, since the phone
reads each one when it builds the card. A proposal carries the owner's
message only on a direct-request turn for Files (`agentActionMode`
`direct-request-v1`, `direct-files-v1` or `direct-files-only-v1`, [device
surfaces](../agent/deviceActions/surfaces.md)), so outside one even a
filter or an open is reviewed on the phone.

```quint
type FilesChatAnswer = FilesProposed | FilesNotNegotiated
pure def filesChatAnswer(kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): FilesChatAnswer =
  if (formAdmitted(kind, form, browserNegotiated, shownNegotiated)) FilesProposed else FilesNotNegotiated
pure def chatKeepsSentIdentities(kind: FilesKind): bool = false
pure def filesChatBound(directRequests: bool, answer: FilesChatAnswer): bool = directRequests and answer == FilesProposed
pure def lawAnUnnegotiatedFormIsNeverProposed(kind: FilesKind, form: FilesForm, browserNegotiated: bool, shownNegotiated: bool): bool =
  not(formAdmitted(kind, form, browserNegotiated, shownNegotiated)) implies filesChatAnswer(kind, form, browserNegotiated, shownNegotiated) == FilesNotNegotiated
pure def lawANegotiatedFormIsProposed(kind: FilesKind): bool = filesChatAnswer(kind, PathForm, true, false) == FilesProposed
pure def lawAChatMoveOrTrashKeepsNoSentIdentity(kind: FilesKind): bool = (kind == MoveKind or kind == TrashKind) implies not(chatKeepsSentIdentities(kind))
pure def lawWithoutDirectRequestsNoFilesProposalIsBound(answer: FilesChatAnswer): bool = not(filesChatBound(false, answer))
```

### A client that shows no review card is proposed only a filter or an open, which it runs directly

A turn whose client shows no review card (`agentActionMode`
`direct-files-only-v1`, such as a phone's voice conversation) can only run a
Files filter or open the owner asked for. Any other Files operation it would
have to review is refused before it is proposed, and the model is told to have
the owner ask in the chat, where the card is shown; so no request waits for a
card nobody can see.

```quint
pure def filesProposedOnTurn(kind: FilesKind, showsCards: bool): bool = showsCards or kind == FilterKind or kind == OpenKind
pure def lawWithoutCardsOnlyAFilterOrAnOpenIsProposed(kind: FilesKind): bool =
  filesProposedOnTurn(kind, false) implies (kind == FilterKind or kind == OpenKind)
pure def lawWithCardsEveryKindIsProposed(kind: FilesKind): bool = filesProposedOnTurn(kind, true)
```

### A Files card is reviewed, and a direct filter or open runs, only on the unlocked phone, and a change only with Files on screen

The phone shows a Files request's card for review, and runs a filter or an
open the owner asked for directly, only while its screen is not sensitive;
a share, move, trash or new folder also needs Files on screen, while a
filter or an open may start from any unlocked screen and bring Files
forward. Until then the card asks the owner to unlock the phone, on a
sensitive screen, or to open Files, and the request waits.

```quint
type FilesCardNotice = FilesReviewable | FilesUnlockNotice | FilesOpenNotice
pure def filesContextKept(kind: FilesKind, sensitive: bool, filesShown: bool): bool =
  not(sensitive) and (kind == FilterKind or kind == OpenKind or filesShown)
pure def filesCardNotice(kind: FilesKind, sensitive: bool, filesShown: bool): FilesCardNotice =
  if (sensitive) FilesUnlockNotice else if (filesContextKept(kind, sensitive, filesShown)) FilesReviewable else FilesOpenNotice
pure def lawASensitiveScreenReviewsNothing(kind: FilesKind, filesShown: bool): bool = filesCardNotice(kind, true, filesShown) == FilesUnlockNotice
pure def lawAChangeNeedsFilesOnScreen(kind: FilesKind): bool =
  (kind != FilterKind and kind != OpenKind) implies filesCardNotice(kind, false, false) == FilesOpenNotice
pure def lawAFilterOrOpenStartsFromAnyUnlockedScreen(filesShown: bool): bool =
  filesCardNotice(FilterKind, false, filesShown) == FilesReviewable and filesCardNotice(OpenKind, false, filesShown) == FilesReviewable
pure def lawEveryKindIsReviewedWithFilesOnTheUnlockedScreen(kind: FilesKind): bool = filesCardNotice(kind, false, true) == FilesReviewable
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
