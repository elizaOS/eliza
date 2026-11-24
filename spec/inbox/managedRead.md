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
override or a missed-only filter is refused without calling the
provider. A bounded read makes exactly one call, for the owner current
when it began.

```quint
type ManagedReadKind = BoundedRead | MissingLimitRead | AccountOverrideRead | MissedOnlyRead
type ManagedReadPhase = ReadIdle | ReadPending | ReadDone | ReadFailed
type ManagedInboxRead = { owner: int, pendingOwner: int, returnedOwner: int, phase: ManagedReadPhase,
  permission: bool, kind: ManagedReadKind, calls: int }
pure val initial: ManagedInboxRead = { owner: 1, pendingOwner: 0, returnedOwner: 0, phase: ReadIdle,
  permission: true, kind: BoundedRead, calls: 0 }
pure def canBeginRead(s: ManagedInboxRead): bool = s.phase == ReadIdle
pure def beginRead(s: ManagedInboxRead, kind: ManagedReadKind): ManagedInboxRead =
  if (kind == BoundedRead) { ...s, kind: kind, phase: ReadPending, pendingOwner: s.owner, calls: 1 }
  else { ...s, kind: kind, phase: ReadFailed, pendingOwner: 0, calls: 0 }
pure def alwaysUnsupportedReadNeverDispatches(s: ManagedInboxRead): bool =
  (s.kind != BoundedRead implies s.calls == 0) and s.calls <= 1
pure def sometimesUnsupportedRefused(s: ManagedInboxRead): bool = s.phase == ReadFailed and s.kind != BoundedRead
```

### A read returns mail only for the current owner while permission holds

While a read is pending the signed-in owner can change and permission
can be revoked. The read returns mail only if permission still holds and
its owner is still the current one; otherwise it fails with no mail. A
source failure also returns no mail. A finished read is followed by a
fresh one, which uses whoever is the owner then. A read not yet begun or
still pending holds no mail.

```quint
pure def canReplaceOwner(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def replaceOwner(s: ManagedInboxRead): ManagedInboxRead = { ...s, owner: 3 - s.owner }
pure def canRevokePermission(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def revokePermission(s: ManagedInboxRead): ManagedInboxRead = { ...s, permission: false }
pure def canReceiveMail(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def receiveMail(s: ManagedInboxRead): ManagedInboxRead =
  if (s.permission and s.pendingOwner == s.owner) { ...s, phase: ReadDone, returnedOwner: s.owner }
  else { ...s, phase: ReadFailed, returnedOwner: 0 }
pure def canSourceFails(s: ManagedInboxRead): bool = s.phase == ReadPending
pure def sourceFails(s: ManagedInboxRead): ManagedInboxRead = { ...s, phase: ReadFailed, returnedOwner: 0 }
pure def canNextRead(s: ManagedInboxRead): bool = s.phase == ReadDone or s.phase == ReadFailed
pure def nextRead(s: ManagedInboxRead): ManagedInboxRead =
  { ...s, phase: ReadIdle, permission: true, kind: BoundedRead, pendingOwner: 0, returnedOwner: 0, calls: 0 }
pure def alwaysCurrentOwnerOnly(s: ManagedInboxRead): bool =
  s.phase == ReadDone implies s.permission and s.returnedOwner == s.owner
pure def alwaysFailureHasNoMail(s: ManagedInboxRead): bool = s.phase == ReadFailed implies s.returnedOwner == 0
pure def sometimesChangedOwnerRefused(s: ManagedInboxRead): bool = s.phase == ReadFailed and s.kind == BoundedRead and s.pendingOwner != s.owner
pure def sometimesMailReturned(s: ManagedInboxRead): bool = s.phase == ReadDone and s.owner == 2
pure val fair_receiveMail = "weak"
pure def alwaysUnfinishedReadHasNoMail(s: ManagedInboxRead): bool =
  (s.phase == ReadIdle or s.phase == ReadPending) implies s.returnedOwner == 0
pure def leadsToReadFinishes(s: ManagedInboxRead, later: ManagedInboxRead): bool =
  s.phase == ReadPending implies later.phase != ReadPending
```

### The agent reads managed mail through the device's broker when the host names one, and otherwise through its cloud link

The agent's managed mail reads go to the device's mail and calendar
broker ([cloud requests](../os/signIn/cloudRequests.md)) whenever the host
names one in `ELIZA_MANAGED_GMAIL_READ_BROKER`: the loopback path
`/__alpha-owner-gmail` with a bearer of 64 URL-safe characters in
`ELIZA_API_TOKEN`. The broker attaches the device's credential itself, so
the agent then sends no mail route through its own cloud link. A host that
names no broker leaves the agent reading through its cloud link, with the
credential it was launched with, as before the broker existed; once the
Cloud requires the mail lease on mail routes, such a read is refused and
reported as a failure. An address or bearer that is not the device's
private one, or no broker and no cloud link, offers neither the read
action nor the access check, rather than failing at every call.

```quint
type MailReader = DeviceBroker | CloudLink | NotOffered
pure def mailReaderOf(brokerNamed: bool, privateAddress: bool, bearerShaped: bool, cloudLinked: bool): MailReader =
  if (brokerNamed) (if (privateAddress and bearerShaped) DeviceBroker else NotOffered)
  else if (cloudLinked) CloudLink
  else NotOffered
pure def lawANamedBrokerIsTheOnlyMailReader(brokerNamed: bool, privateAddress: bool, bearerShaped: bool, cloudLinked: bool): bool =
  brokerNamed implies mailReaderOf(brokerNamed, privateAddress, bearerShaped, cloudLinked) != CloudLink
pure def lawMailIsReadThroughABrokerOnlyWhenItIsPrivate(brokerNamed: bool, privateAddress: bool, bearerShaped: bool, cloudLinked: bool): bool =
  (mailReaderOf(brokerNamed, privateAddress, bearerShaped, cloudLinked) == DeviceBroker) iff (brokerNamed and privateAddress and bearerShaped)
pure def lawWithoutABrokerTheCloudLinkReads(brokerNamed: bool, privateAddress: bool, bearerShaped: bool, cloudLinked: bool): bool =
  (mailReaderOf(brokerNamed, privateAddress, bearerShaped, cloudLinked) == CloudLink) iff (not(brokerNamed) and cloudLinked)
```
