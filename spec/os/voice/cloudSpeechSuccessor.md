# Cloud speech successor session

When a [cloud speech](./cloudSpeech.md) session rotates, the client
prepares a successor while the predecessor still runs. One owner, one
predecessor and at most one current successor are involved. Consent to the
successor creates only a recoverable ledger on the server; recovering it,
minting the provider session and opening its socket all wait for the
predecessor's exact retirement. The server half is
[cloud speech](../../cloud/speech.md).

## Story: Rotate a cloud speech session without two live providers

> As a person in a long cloud voice conversation, I want the next session
> to take over only once the previous one is really gone, and a cancelled
> or changed session never to open.

### The successor is minted and opened only after the predecessor retired

Releasing, recovering and minting the prepared successor, and opening its
socket, need the predecessor's retirement to be confirmed, not merely
begun or of unknown outcome. Minting needs a consent whose response was
received. An open socket needs the owner, the successor binding and the
configuration to be unchanged, no cancellation or expiry, and an open
ledger.

```quint
type Predecessor = PredecessorLive | PredecessorRetiring | PredecessorUnknown | PredecessorRetired
type Preparation = NotPrepared | PreparedKnown | PreparedUnknown
type Successor = { predecessor: Predecessor, preparation: Preparation, ownerCurrent: bool, matching: bool,
  configurationCurrent: bool, linked: bool, cancelled: bool, expired: bool, released: bool, recovered: bool,
  minted: bool, socket: bool, ledgerClosed: bool, retried: bool }
pure val initial: Successor = { predecessor: PredecessorLive, preparation: NotPrepared, ownerCurrent: true, matching: true,
  configurationCurrent: true, linked: false, cancelled: false, expired: false, released: false, recovered: false,
  minted: false, socket: false, ledgerClosed: false, retried: false }
pure def successorValid(s: Successor): bool =
  s.ownerCurrent and s.matching and s.configurationCurrent and not(s.cancelled) and not(s.expired)
pure def canPrepareSuccessor(s: Successor): bool =
  successorValid(s) and s.preparation == NotPrepared and s.predecessor == PredecessorLive and not(s.linked)
pure def prepareSuccessor(s: Successor): Successor = { ...s, preparation: PreparedKnown, linked: true }
pure def canBeginRetirement(s: Successor): bool = s.predecessor == PredecessorLive
pure def beginRetirement(s: Successor): Successor = { ...s, predecessor: PredecessorRetiring }
pure def canLoseRetirement(s: Successor): bool = s.predecessor == PredecessorRetiring
pure def loseRetirement(s: Successor): Successor = { ...s, predecessor: PredecessorUnknown }
pure def canConfirmRetirement(s: Successor): bool =
  s.predecessor == PredecessorRetiring or s.predecessor == PredecessorUnknown
pure def confirmRetirement(s: Successor): Successor = { ...s, predecessor: PredecessorRetired }
pure def canReleaseSuccessor(s: Successor): bool =
  successorValid(s) and s.predecessor == PredecessorRetired and s.preparation == PreparedKnown and not(s.ledgerClosed)
pure def releaseSuccessor(s: Successor): Successor = { ...s, released: true }
pure def canRecoverSuccessor(s: Successor): bool = successorValid(s) and s.released and not(s.ledgerClosed)
pure def recoverSuccessor(s: Successor): Successor = { ...s, recovered: true }
pure def canMintSuccessor(s: Successor): bool =
  successorValid(s) and s.released and s.recovered and not(s.ledgerClosed) and s.preparation == PreparedKnown
pure def mintSuccessor(s: Successor): Successor = { ...s, minted: true }
pure def canOpenSuccessorSocket(s: Successor): bool = successorValid(s) and s.minted and not(s.ledgerClosed)
pure def openSuccessorSocket(s: Successor): Successor = { ...s, socket: true }
pure def alwaysSuccessorWaitsForRetirement(s: Successor): bool =
  (s.released or s.recovered or s.minted or s.socket) implies s.predecessor == PredecessorRetired
pure def alwaysMintNeedsKnownConsent(s: Successor): bool = s.minted implies s.preparation == PreparedKnown
pure def alwaysSocketNeedsCurrentSuccessor(s: Successor): bool =
  s.socket implies successorValid(s) and s.minted and not(s.ledgerClosed)
pure def sometimesSuccessorSocketOpen(s: Successor): bool = s.socket
pure val weight_prepareSuccessor = 10
pure val weight_beginRetirement = 10
pure val weight_confirmRetirement = 10
pure val weight_releaseSuccessor = 10
pure val weight_recoverSuccessor = 10
pure val weight_mintSuccessor = 10
pure val weight_openSuccessorSocket = 10
```

### A lost consent response leaves only a server-expiring ledger

When the consent response is lost the client does not know whether a
ledger exists. Nothing is linked and no provider is minted from it; the
server lets that ledger expire.

```quint
pure def canLoseConsent(s: Successor): bool =
  successorValid(s) and s.preparation == NotPrepared and s.predecessor == PredecessorLive
pure def loseConsent(s: Successor): Successor = { ...s, preparation: PreparedUnknown, linked: false }
pure def sometimesUnknownConsentBlocksMint(s: Successor): bool =
  s.preparation == PreparedUnknown and s.predecessor == PredecessorRetired and not(s.minted)
```

### Cancellation, expiry or a changed owner, binding or route closes the socket

Each of these drops the socket at once, and cancellation and expiry also
unlink the successor. A known ledger that is no longer valid is cleaned up,
which also closes the socket.

```quint
pure def cancelSuccessor(s: Successor): Successor = { ...s, cancelled: true, socket: false, linked: false }
pure def expireSuccessor(s: Successor): Successor = { ...s, expired: true, socket: false, linked: false }
pure def canChangeOwner(s: Successor): bool = s.ownerCurrent
pure def changeOwner(s: Successor): Successor = { ...s, ownerCurrent: false, socket: false }
pure def canMismatchSuccessor(s: Successor): bool = s.matching
pure def mismatchSuccessor(s: Successor): Successor = { ...s, matching: false, socket: false }
pure def canChangeConfiguration(s: Successor): bool = s.configurationCurrent
pure def changeConfiguration(s: Successor): Successor = { ...s, configurationCurrent: false, socket: false }
pure def canConfirmCleanup(s: Successor): bool = s.preparation == PreparedKnown and not(successorValid(s))
pure def confirmCleanup(s: Successor): Successor = { ...s, ledgerClosed: true, socket: false }
pure def stepInvalidationClosesSocket(before: Successor, after: Successor): bool =
  not(successorValid(after)) implies not(after.socket)
pure def sometimesCleanedAfterCancel(s: Successor): bool = s.ledgerClosed and s.cancelled and not(s.minted)
```

### A new request starts only after the prior link cleared

An explicit retry is allowed only while the predecessor is still live,
the owner, binding and route are unchanged, nothing is linked, and either
the earlier known ledger's cleanup was confirmed or its consent response
was lost. It clears cancellation, expiry and the closed ledger.

```quint
pure def canRetrySuccessor(s: Successor): bool =
  s.predecessor == PredecessorLive and s.ownerCurrent and s.matching and s.configurationCurrent and
  not(s.linked) and (s.ledgerClosed or s.preparation == PreparedUnknown)
pure def retrySuccessor(s: Successor): Successor =
  { ...s, preparation: NotPrepared, cancelled: false, expired: false, ledgerClosed: false, retried: true }
pure def sometimesRetriedSuccessorLinked(s: Successor): bool =
  s.retried and s.linked and s.predecessor == PredecessorLive and s.preparation == PreparedKnown
```
