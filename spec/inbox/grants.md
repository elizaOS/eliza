# Incremental Gmail grants

The inbox asks Google for mail access in two steps: read first, and the
mailbox changes (send, provider drafts, archive, Trash, read state and
stars) once, as one incremental consent, only when the owner starts an
approved change. Which Google scopes back each capability is
[the connection's](../cloud/services/google/connection.md) table; this
library decides what the inbox asks for, what it may do with what it
holds, and what a re-read of the account list invalidates.
[Mailbox reads](./reads.md) key their caches by the identity named here, and
[drafts](./drafts.md) drop unsent reviews a withdrawn grant no longer allows.

## Story: Grant Gmail access one step at a time

> As the owner, I want the inbox to ask only for reading my mail until I
> start a change, to ask for changes once, and never to lose access I
> already granted when I reconnect.

### Read is asked for first, changes are one consent, and a reconnect keeps what the account holds

Every consent asks for the basic identity and Gmail read. The modify step
adds send, provider drafts and mailbox changes together, so Google shows
one consent rather than three; a single change capability may also be
asked for on its own. Cloud maps exactly the capabilities a consent names
to scopes, so a consent also names every Gmail capability the selected
account already holds. Capabilities that are not Gmail's are not carried.

```quint
type GmailCapability = GoogleIdentity | GmailRead | GmailSend | GmailDrafts | GmailMailbox
type GrantRequest = AskRead | AskModify | AskSend | AskDrafts | AskMailbox
pure val modifyCapabilities: Set[GmailCapability] = Set(GmailSend, GmailDrafts, GmailMailbox)
pure val readCapabilities: Set[GmailCapability] = Set(GoogleIdentity, GmailRead)
pure def requestedCapabilities(request: GrantRequest): Set[GmailCapability] =
  if (request == AskRead) readCapabilities
  else if (request == AskModify) readCapabilities.union(modifyCapabilities)
  else if (request == AskSend) readCapabilities.union(Set(GmailSend))
  else if (request == AskDrafts) readCapabilities.union(Set(GmailDrafts))
  else readCapabilities.union(Set(GmailMailbox))
pure def consentCapabilities(request: GrantRequest, held: Set[GmailCapability]): Set[GmailCapability] =
  requestedCapabilities(request).union(held)
pure val heldValues = Set(Set(), Set(GmailRead), Set(GoogleIdentity, GmailRead, GmailSend), Set(GmailRead, GmailSend, GmailDrafts, GmailMailbox))
pure def lawEveryConsentAsksToRead(request: GrantRequest, held: Set[GmailCapability]): bool =
  readCapabilities.subseteq(consentCapabilities(request, held))
pure def lawReconnectKeepsHeldAccess(request: GrantRequest, held: Set[GmailCapability]): bool =
  held.subseteq(consentCapabilities(request, held))
pure def lawModifyIsOneConsent(held: Set[GmailCapability]): bool =
  modifyCapabilities.subseteq(consentCapabilities(AskModify, held))
```

### An approved change is prepared only under the capability it needs, and otherwise offers the upgrade

An account is readable when it is connected, names its connection and
holds Gmail read. Its tier is none, read only, or modify when it holds all
three change capabilities. A send needs the send capability, a provider
draft change the drafts capability and every other mailbox change the
mailbox capability. A change is prepared only when the account is readable
and holds what it needs; a readable account without it is offered the
single modify consent, and nothing is prepared or dispatched. The server's
own per-account capabilities must also allow the change at that moment.

```quint
type MailboxAction = ActSend | ActDraftCreate | ActDraftReplace | ActDraftDelete | ActArchive | ActUnarchive
  | ActTrash | ActUntrash | ActMarkRead | ActMarkUnread | ActStar | ActUnstar
type ActionGrant = ChangeGranted | ChangeNeedsUpgrade | AccountUnreadable
type GrantTier = NoTier | ReadOnlyTier | ModifyTier
type GmailGrant = { connected: bool, hasConnection: bool, held: Set[GmailCapability] }
type ServerAllows = { sendAllowed: bool, draftsAllowed: bool, mailboxAllowed: bool }
pure def requiredCapability(mailboxAction: MailboxAction): GmailCapability =
  if (mailboxAction == ActSend) GmailSend
  else if (mailboxAction == ActDraftCreate or mailboxAction == ActDraftReplace or mailboxAction == ActDraftDelete) GmailDrafts
  else GmailMailbox
pure def accountReadable(grant: GmailGrant): bool = grant.connected and grant.hasConnection and grant.held.contains(GmailRead)
pure def grantTier(grant: GmailGrant): GrantTier =
  if (not(accountReadable(grant))) NoTier else if (modifyCapabilities.subseteq(grant.held)) ModifyTier else ReadOnlyTier
pure def actionGrant(grant: GmailGrant, mailboxAction: MailboxAction): ActionGrant =
  if (not(accountReadable(grant))) AccountUnreadable
  else if (grant.held.contains(requiredCapability(mailboxAction))) ChangeGranted
  else ChangeNeedsUpgrade
pure def serverAllows(allows: ServerAllows, mailboxAction: MailboxAction): bool =
  if (requiredCapability(mailboxAction) == GmailSend) allows.sendAllowed
  else if (requiredCapability(mailboxAction) == GmailDrafts) allows.draftsAllowed
  else allows.mailboxAllowed
pure val grantValues = Set(
  { connected: true, hasConnection: true, held: Set(GmailRead) },
  { connected: true, hasConnection: true, held: Set(GmailRead, GmailSend, GmailDrafts, GmailMailbox) },
  { connected: true, hasConnection: false, held: Set(GmailRead, GmailSend) },
  { connected: false, hasConnection: true, held: Set(GmailRead, GmailMailbox) })
pure def lawUnreadableAccountChangesNothing(grant: GmailGrant, mailboxAction: MailboxAction): bool =
  not(accountReadable(grant)) implies actionGrant(grant, mailboxAction) == AccountUnreadable and grantTier(grant) == NoTier
pure def lawGrantedChangeHoldsItsCapability(grant: GmailGrant, mailboxAction: MailboxAction): bool =
  actionGrant(grant, mailboxAction) == ChangeGranted implies accountReadable(grant) and grant.held.contains(requiredCapability(mailboxAction))
pure def lawModifyTierGrantsEveryChange(grant: GmailGrant, mailboxAction: MailboxAction): bool =
  grantTier(grant) == ModifyTier implies actionGrant(grant, mailboxAction) == ChangeGranted
```

### Cached mail and unsent reviews belong to the grant that read or prepared them

What was read under one key is shown only under the same key: the Cloud
session, the connection and the read grant. Without a session or a
readable account there is no key and nothing may be shown. A re-read of the
account list drops cached mail when either key is missing or they differ,
and withdraws every change capability the account held before that it no
longer holds, or all of them when the cache is dropped, so an unsent review
is never dispatched against a grant the owner has since withdrawn.

```quint
type ReadIdentity = { session: str, connection: str, readable: bool }
pure def readKeyed(identity: ReadIdentity): bool = identity.session != "" and identity.connection != "" and identity.readable
pure def readCacheDropped(before: ReadIdentity, after: ReadIdentity): bool =
  not(readKeyed(before)) or not(readKeyed(after)) or before.session != after.session or before.connection != after.connection
pure def capabilityWithdrawn(heldBefore: Set[GmailCapability], heldAfter: Set[GmailCapability], dropped: bool, capability: GmailCapability): bool =
  modifyCapabilities.contains(capability) and heldBefore.contains(capability) and (dropped or not(heldAfter.contains(capability)))
pure val beforeValues = Set(
  { session: "s", connection: "a", readable: true },
  { session: "s", connection: "b", readable: true },
  { session: "t", connection: "a", readable: true },
  { session: "s", connection: "a", readable: false },
  { session: "", connection: "a", readable: true })
pure val afterValues = beforeValues
pure val heldBeforeValues = heldValues
pure val heldAfterValues = heldValues
pure def lawAnotherAccountNeverSeesCachedMail(before: ReadIdentity, after: ReadIdentity): bool =
  (before.connection != after.connection or before.session != after.session) implies readCacheDropped(before, after)
pure def lawRevokedReadDropsCachedMail(before: ReadIdentity, after: ReadIdentity): bool =
  not(after.readable) implies readCacheDropped(before, after)
pure def lawDroppedCacheWithdrawsEveryHeldChange(heldBefore: Set[GmailCapability], heldAfter: Set[GmailCapability], capability: GmailCapability): bool =
  (modifyCapabilities.contains(capability) and heldBefore.contains(capability)) implies capabilityWithdrawn(heldBefore, heldAfter, true, capability)
pure def lawReadIsNeverWithdrawnAsAChange(heldBefore: Set[GmailCapability], heldAfter: Set[GmailCapability], dropped: bool): bool =
  not(capabilityWithdrawn(heldBefore, heldAfter, dropped, GmailRead))
```
