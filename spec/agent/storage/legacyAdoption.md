# Installed resident adoption

The normal device-store open starts or resumes `store-v4`. An installed
resident changes formats through a separate native-authorized adoption.
It keeps the installed store and encrypted vault available. The new agent
cannot serve imported data until a complete, bound generation is verified
and published. An import does not enroll a renderer or restore a live
device handle.

## Story: Keep the conversations and turns from my installed agent

> As the owner, I want an update to keep the conversations I already had,
> with their existing links, send identities and replies. Retrying a turn
> from before the update must never cause its work to happen again.

### A historical conversation keeps its owner and existing identifiers

The native host supplies the authenticated installed agent, owner entity
and conversation world from one retired writer generation. The offline
extractor reads a private disposable copy of the installed runtime store.
It checks the durable conversation catalog against its room and message
rows. It refuses missing or duplicate identifiers, another owner's room,
and links that cross rooms. The projection keeps the conversation ID, room
ID, message IDs, owner and agent IDs, timestamps and message text. This
projection prepares history only. Installed task journals, device claims,
effect receipts and encrypted vault entries require their own admission
before a complete generation can be offered to the native host.

```quint
type HistoryBinding = { sameAgent: bool, sameOwner: bool, sameWorld: bool, uniqueIdentity: bool, closedReferences: bool }
type HistoryAnswer = HistoryPrepared | HistoryRefused
pure def historyAnswer(h: HistoryBinding): HistoryAnswer =
  if (h.sameAgent and h.sameOwner and h.sameWorld and h.uniqueIdentity and h.closedReferences) HistoryPrepared else HistoryRefused
pure val hValues = Set(
  { sameAgent: true, sameOwner: true, sameWorld: true, uniqueIdentity: true, closedReferences: true },
  { sameAgent: false, sameOwner: true, sameWorld: true, uniqueIdentity: true, closedReferences: true },
  { sameAgent: true, sameOwner: false, sameWorld: true, uniqueIdentity: true, closedReferences: true },
  { sameAgent: true, sameOwner: true, sameWorld: false, uniqueIdentity: true, closedReferences: true },
  { sameAgent: true, sameOwner: true, sameWorld: true, uniqueIdentity: false, closedReferences: true },
  { sameAgent: true, sameOwner: true, sameWorld: true, uniqueIdentity: true, closedReferences: false })
pure def lawHistoricalRowsKeepTheirAuthority(h: HistoryBinding): bool =
  historyAnswer(h) == HistoryPrepared implies h.sameAgent and h.sameOwner and h.sameWorld
pure def lawIncompleteHistoryCannotBePrepared(h: HistoryBinding): bool =
  historyAnswer(h) == HistoryPrepared implies h.uniqueIdentity and h.closedReferences
```

### The installed catalogue uses channel identities and keeps deleted conversations deleted

The compatibility reader runs offline with a read-only transaction on the
disposable database copy. The native handover supplies the expected
installed identity and the deletion ledger captured with that database.
As with the installed runtime, the catalogue starts with the agent's own
participation records and its `client_chat` rooms with `web-conv-`
channels. The channel gives the conversation UUID and must derive the
same room UUID. Extra metadata may repeat that conversation UUID or omit
it. A conflicting value or malformed direct room refuses preparation.
A conversation in the installed tombstone ledger is excluded even if its
room or messages remain in the database. A verified missing ledger is
empty. A malformed ledger cannot be used.

The reader takes the room creation timestamp and the latest of that
timestamp and its retained messages. It preserves UTC millisecond
precision. The projection checks message ownership and references. An
explicit message world must match the room; a message without its own
world inherits from its room. Unrelated room sources and other memory
tables are excluded. The reader opens no endpoint and grants no
publication, request replay or device execution authority.

```quint
type CatalogueAnswer = ExcludeDeleted | ReadConversation | RefuseCatalogue
pure def catalogueAnswer(canonicalChannel: bool, roomMatches: bool, metadataMatches: bool, directRoom: bool, deleted: bool): CatalogueAnswer =
  if (not(canonicalChannel)) RefuseCatalogue else if (deleted) ExcludeDeleted
  else if (roomMatches and metadataMatches and directRoom) ReadConversation else RefuseCatalogue
pure def lawDeletedConversationIsNeverRead(canonicalChannel: bool, roomMatches: bool, metadataMatches: bool, directRoom: bool): bool =
  catalogueAnswer(canonicalChannel, roomMatches, metadataMatches, directRoom, true) != ReadConversation
pure def lawCatalogueRequiresExactRoomIdentity(canonicalChannel: bool, roomMatches: bool, metadataMatches: bool, directRoom: bool, deleted: bool): bool =
  catalogueAnswer(canonicalChannel, roomMatches, metadataMatches, directRoom, deleted) == ReadConversation
    implies canonicalChannel and roomMatches and metadataMatches and directRoom and not(deleted)
```

### An installed send key never dispatches a new turn

A stored send key binds the installed agent, room and owner entity. The
original input memory ID must agree with that scope and key. Its original
request fingerprint remains tagged as the installed protocol. The import
records an original linked reply ID where one exists. This identity alone
does not prove the outcome of a device or provider effect. Reserve every
valid installed key even when no reply can be established. Replaying an
installed key can return the original historical reply only with a matching
installed request fingerprint and a verified terminal outcome. All other
uses of that key need reconciliation or conflict resolution. A live device
action, provider dispatch or review must not be reconstructed from it.

```quint
type PriorSend = NoPriorSend | InstalledUnsettled | InstalledTerminal
type ReplayAnswer = NewSend | HistoricalReply | NeedsReconciliation | PriorSendConflict
pure def installedReplay(prior: PriorSend, sameFingerprint: bool): ReplayAnswer =
  if (prior == NoPriorSend) NewSend
  else if (not(sameFingerprint)) PriorSendConflict
  else if (prior == InstalledTerminal) HistoricalReply else NeedsReconciliation
pure def lawInstalledKeysNeverDispatch(prior: PriorSend, sameFingerprint: bool): bool =
  prior != NoPriorSend implies installedReplay(prior, sameFingerprint) != NewSend
pure def lawHistoricalReplyNeedsExactTerminalProof(prior: PriorSend, sameFingerprint: bool): bool =
  installedReplay(prior, sameFingerprint) == HistoricalReply iff (prior == InstalledTerminal and sameFingerprint)
```

### The projected history is staged and verified before it can be published

A history-only stage uses a fresh directory beneath a private parent. Its
identity file names the installed agent. The usual v4 device store writes
rooms, messages and reserved send keys in one transaction. The stage is
closed, reopened with the exact identity and account, and read back. A
stage that fails preparation or verification is removed. Even a verified
history-only stage remains outside the live launch path. The later handover
must also admit the installed task, device and vault domains before it can
publish a generation.
