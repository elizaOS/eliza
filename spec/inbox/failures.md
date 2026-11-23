# Mail failures and disconnect

How a failed managed Gmail request is told to the owner, the same way in
Inbox and in Settings, and how an explicit disconnect is confirmed. The
refusal codes are [Cloud's](../cloud/shared/types.md); a read and a
reviewed change say different things about the same failure because a
change may have reached Gmail. No provider content is kept here.

## Story: Know what happened when Gmail fails

> As the owner, I want a failed read or change to tell me whether to
> reconnect, reload, refresh, retry or check a receipt, and never to claim
> that nothing changed when a change may have gone through.

### A failure is classified by the client's own refusal first, then by being offline, then by Cloud's code and status

A file this client refused (its bytes, name or size) is refused, online or
not, and a retry cannot change it. Otherwise an offline device is offline.
A Cloud refusal is classified by its code: reauthorization is revoked, a
stale revision is stale, not found is gone. Without a known code, 403 and
404 are revoked, 409 is revoked for a read and stale for a change, 400 and
413 are rejected, and any other status or an unreadable answer is
unavailable. A lost connection is offline; anything else is unavailable.

```quint
type FailureContext = ReadContext | OperationContext
type FailureKind = OfflineFailure | RevokedFailure | StaleFailure | GoneFailure | UnavailableFailure | RefusedFailure | RejectedFailure
type CloudCode = NoCloudCode | ReauthCode | StaleCode | NotFoundCode | OtherCode
type FailureSource = AttachmentRefusal | CloudRefusal({ status: int, code: CloudCode }) | UnreadableAnswer | ConnectionLost | OtherFault
pure def refusalFailure(status: int, code: CloudCode, context: FailureContext): FailureKind =
  if (code == ReauthCode) RevokedFailure
  else if (code == StaleCode) StaleFailure
  else if (code == NotFoundCode) GoneFailure
  else if (status == 403 or status == 404) RevokedFailure
  else if (status == 409) { if (context == ReadContext) RevokedFailure else StaleFailure }
  else if (status == 400 or status == 413) RejectedFailure
  else UnavailableFailure
pure def classifyFailure(source: FailureSource, context: FailureContext, online: bool): FailureKind = match source {
  | AttachmentRefusal => RefusedFailure
  | CloudRefusal(r) => if (not(online)) OfflineFailure else refusalFailure(r.status, r.code, context)
  | UnreadableAnswer => if (not(online)) OfflineFailure else UnavailableFailure
  | ConnectionLost => OfflineFailure
  | OtherFault => if (not(online)) OfflineFailure else UnavailableFailure
}
pure val sourceValues = Set(AttachmentRefusal, UnreadableAnswer, ConnectionLost, OtherFault,
  CloudRefusal({ status: 409, code: NoCloudCode }), CloudRefusal({ status: 400, code: StaleCode }),
  CloudRefusal({ status: 404, code: NoCloudCode }), CloudRefusal({ status: 502, code: OtherCode }), CloudRefusal({ status: 413, code: NoCloudCode }))
pure def lawRefusedFileHoldsOffline(context: FailureContext, online: bool): bool =
  classifyFailure(AttachmentRefusal, context, online) == RefusedFailure
pure def lawOfflineIsSaidFirst(source: FailureSource, context: FailureContext): bool =
  source != AttachmentRefusal implies classifyFailure(source, context, false) == OfflineFailure
pure def lawCloudCodeDecidesOverStatus(status: int, context: FailureContext): bool =
  classifyFailure(CloudRefusal({ status: status, code: ReauthCode }), context, true) == RevokedFailure and
  classifyFailure(CloudRefusal({ status: status, code: StaleCode }), context, true) == StaleFailure
pure def lawConflictMeansStaleOnlyForChanges(online: bool): bool =
  online implies (classifyFailure(CloudRefusal({ status: 409, code: NoCloudCode }), ReadContext, online) == RevokedFailure and
    classifyFailure(CloudRefusal({ status: 409, code: NoCloudCode }), OperationContext, online) == StaleFailure)
```

### An offline or unavailable change never claims that nothing changed

The words of a read say what to do to see mail again. The words of a
change that may have reached Gmail, offline, rejected or unavailable,
point to its saved receipt and never say that nothing changed; only a
revoked grant, a stale revision, a message no longer in Gmail or a refused
file say that nothing was changed.

```quint
pure def changeSaysNothingChanged(kind: FailureKind): bool =
  kind == RevokedFailure or kind == StaleFailure or kind == GoneFailure or kind == RefusedFailure
pure def changeMayHaveLanded(kind: FailureKind): bool = kind == OfflineFailure or kind == RejectedFailure or kind == UnavailableFailure
pure def lawUncertainChangeNeverSaysNothingChanged(kind: FailureKind): bool =
  changeMayHaveLanded(kind) implies not(changeSaysNothingChanged(kind))
```

### A disconnect is asked for once and then read back

Disconnect asks Cloud once and is never retried. The account list is then
read back: the account is disconnected when it no longer reports connected,
still connected when the request was answered and it still does, and
unconfirmed when the request failed and it still does, or when the list
could not be read. A disconnect deletes no mail, and local drafts stay on
the phone until the owner discards them.

```quint
type DisconnectOutcome = Disconnected | StillConnected | DisconnectUnconfirmed
type ReadBack = ListUnreadable | ListShowsConnected | ListShowsDisconnected
pure def disconnectOutcome(requestAnswered: bool, readBack: ReadBack): DisconnectOutcome =
  if (readBack == ListUnreadable) DisconnectUnconfirmed
  else if (readBack == ListShowsDisconnected) Disconnected
  else if (requestAnswered) StillConnected
  else DisconnectUnconfirmed
pure def lawDisconnectedOnlyWhenTheListSaysSo(requestAnswered: bool, readBack: ReadBack): bool =
  disconnectOutcome(requestAnswered, readBack) == Disconnected implies readBack == ListShowsDisconnected
pure def lawFailedRequestIsNeverStillConnected(readBack: ReadBack): bool = disconnectOutcome(false, readBack) != StillConnected
```
