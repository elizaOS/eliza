# Managed inbox read

A managed account's aggregate inbox read is a fresh read for the owner
who asked for it, never served from a cache, and a read the managed
route does not support is refused before anything is sent. The Cloud
side of the read is [managed Gmail](../cloud/index.md#an-approved-connection-grants-the-owner-only-the-selected-reads); the
device's own cached reads are [mailbox reads](./reads.md).

## Story: Read my managed inbox fresh, and only for me

> As the owner, I want a managed inbox read to return mail only for the
> account I am signed in as, while it still has permission, and never
> from a cache another owner could have filled.

### Only a bounded read is dispatched; any other request fails without a call

A managed read must be bounded. A read with a missing limit, an account
override or a missed-only filter is refused before any Cloud request.
For a bounded read, look up the owner's Gmail grants. If exactly one
connected grant has Gmail read access, make one search naming that
grant. If none or several are readable, refuse without searching.

```quint
type ManagedReadKind = BoundedRead | MissingLimitRead | AccountOverrideRead | MissedOnlyRead
type ManagedReadPhase = ReadIdle | ReadPending | ReadDone | ReadFailed
type ManagedReadGrant = NoReadableGrant | SeveralReadableGrants | OneReadableGrant({ grantId: str })
type ManagedInboxRead = { owner: int, pendingOwner: int, pendingGrant: str, returnedOwner: int, phase: ManagedReadPhase,
  permission: bool, kind: ManagedReadKind, calls: int }
pure val initial: ManagedInboxRead = { owner: 1, pendingOwner: 0, pendingGrant: "", returnedOwner: 0, phase: ReadIdle,
  permission: true, kind: BoundedRead, calls: 0 }
pure val grantValues = Set(NoReadableGrant, SeveralReadableGrants, OneReadableGrant({ grantId: "grant-a" }), OneReadableGrant({ grantId: "grant-b" }))
pure val grantIdValues = Set("", "grant-a", "grant-b")
pure def chooseManagedReadGrant(readableIds: List[str]): ManagedReadGrant =
  val id = readableIds.nthOr(0, "")
  if (readableIds.length() > 1) SeveralReadableGrants
  else if (id == "") NoReadableGrant
  else OneReadableGrant({ grantId: id })
pure def canBeginRead(s: ManagedInboxRead): bool = s.phase == ReadIdle
pure def beginRead(s: ManagedInboxRead, kind: ManagedReadKind, grant: ManagedReadGrant): ManagedInboxRead =
  val id = match grant { | OneReadableGrant(named) => named.grantId | _ => "" }
  if (kind == BoundedRead and id != "") { ...s, kind: kind, phase: ReadPending, pendingOwner: s.owner, pendingGrant: id, calls: 1 }
  else { ...s, kind: kind, phase: ReadFailed, pendingOwner: 0, pendingGrant: "", calls: 0 }
pure def alwaysUnsupportedReadNeverDispatches(s: ManagedInboxRead): bool =
  (s.kind != BoundedRead implies s.calls == 0) and s.calls <= 1
pure def alwaysSearchNamesAReadableGrant(s: ManagedInboxRead): bool =
  s.calls == 1 implies s.pendingGrant != ""
pure def sometimesUnsupportedRefused(s: ManagedInboxRead): bool = s.phase == ReadFailed and s.kind != BoundedRead
```

### A read returns mail only for the current owner while permission holds

While a read is pending the signed-in owner can change and permission
can be revoked. After searching, look up the owner's grants again.
Return mail only while the owner and permission still hold and the
searched grant remains the only readable grant. A source failure also
returns no mail. A finished read is followed by a fresh one, which uses
whoever is the owner then. A read not yet begun or still pending holds
no mail.

```quint
pure def canReplaceOwner(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def replaceOwner(s: ManagedInboxRead): ManagedInboxRead = { ...s, owner: 3 - s.owner }
pure def canRevokePermission(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def revokePermission(s: ManagedInboxRead): ManagedInboxRead = { ...s, permission: false }
pure def canReceiveMail(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def receiveMail(s: ManagedInboxRead, grant: ManagedReadGrant): ManagedInboxRead =
  if (s.permission and s.pendingOwner == s.owner and s.pendingGrant != "" and grant == OneReadableGrant({ grantId: s.pendingGrant }))
    { ...s, phase: ReadDone, returnedOwner: s.owner }
  else { ...s, phase: ReadFailed, returnedOwner: 0 }
pure def lawMailRequiresSameUniqueGrant(grantId: str, grant: ManagedReadGrant): bool =
  val pending = beginRead(initial, BoundedRead, OneReadableGrant({ grantId: grantId }))
  (receiveMail(pending, grant).phase == ReadDone) == (grantId != "" and grant == OneReadableGrant({ grantId: grantId }))
pure def canSourceFails(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def sourceFails(s: ManagedInboxRead): ManagedInboxRead = { ...s, phase: ReadFailed, returnedOwner: 0 }
pure def canNextRead(s: ManagedInboxRead): bool = s.phase == ReadDone or s.phase == ReadFailed
pure def nextRead(s: ManagedInboxRead): ManagedInboxRead =
  { ...s, phase: ReadIdle, permission: true, kind: BoundedRead, pendingOwner: 0, pendingGrant: "", returnedOwner: 0, calls: 0 }
pure def alwaysCurrentOwnerOnly(s: ManagedInboxRead): bool =
  s.phase == ReadDone implies s.permission and s.returnedOwner == s.owner
pure def alwaysFailureHasNoMail(s: ManagedInboxRead): bool = s.phase == ReadFailed implies s.returnedOwner == 0
pure def sometimesChangedOwnerRefused(s: ManagedInboxRead): bool = s.phase == ReadFailed and s.calls == 1 and s.pendingOwner != s.owner
pure def sometimesMailReturned(s: ManagedInboxRead): bool = s.phase == ReadDone and s.owner == 2
pure val fair_receiveMail = "weak"
pure def alwaysUnfinishedReadHasNoMail(s: ManagedInboxRead): bool =
  (s.phase == ReadIdle or s.phase == ReadPending) implies s.returnedOwner == 0
pure def leadsToReadFinishes(s: ManagedInboxRead, later: ManagedInboxRead): bool =
  s.phase == ReadPending implies later.phase != ReadPending
```

### The agent reads managed mail through the device's broker when the host names one, and otherwise through its cloud link

When the host names the device's mail broker
([cloud requests](../os/signIn/cloudRequests.md)) in
`ELIZA_MANAGED_GMAIL_READ_BROKER`, the agent sends every managed mail read
there and none through its own cloud link: the broker attaches the mail
lease, which the agent never holds, where the cloud refuses the device key
the agent holds. The broker is named only as `http://127.0.0.1:<port>/__owner-gmail`
with a bearer of 64 URL-safe characters in
`ELIZA_MANAGED_GMAIL_READ_BROKER_TOKEN`; any other address or bearer offers
no read, and the agent does not fall back to its cloud link. Through the
broker the agent only reads: a change it asks for is refused without a call.
A host that names no broker leaves the agent reading through its cloud link
with the credential it was launched with. With neither, the read action and
the access check are not offered.

```quint
type MailReader = DeviceBroker | CloudLink | NotOffered
pure def mailReaderOf(brokerNamed: bool, brokerPrivate: bool, cloudLinked: bool): MailReader =
  if (brokerNamed) (if (brokerPrivate) DeviceBroker else NotOffered)
  else if (cloudLinked) CloudLink
  else NotOffered
pure def lawANamedBrokerIsTheOnlyMailReader(brokerNamed: bool, brokerPrivate: bool, cloudLinked: bool): bool =
  brokerNamed implies mailReaderOf(brokerNamed, brokerPrivate, cloudLinked) != CloudLink
pure def lawMailIsReadThroughABrokerOnlyWhenItIsPrivate(brokerNamed: bool, brokerPrivate: bool, cloudLinked: bool): bool =
  (mailReaderOf(brokerNamed, brokerPrivate, cloudLinked) == DeviceBroker) iff (brokerNamed and brokerPrivate)
pure def lawWithoutABrokerTheCloudLinkReads(brokerNamed: bool, brokerPrivate: bool, cloudLinked: bool): bool =
  (mailReaderOf(brokerNamed, brokerPrivate, cloudLinked) == CloudLink) iff (not(brokerNamed) and cloudLinked)
```
