# Cloud client

An agent and the app around it reach the cloud through one client: it shows
whether the device is signed in to the cloud, signs out, routes each model
capability to the cloud or to local providers by typed configuration, and
streams completions. The session view is the state machine: replies from the
host may arrive after the host was replaced or the view torn down, and only
the current one may change what the user sees. Disconnecting, capability
routing, stream completion and warmup are stated as laws.

## Story: See my cloud session as it is now

> As a device owner, I want the app to show whether I am signed in to the
> cloud as the current host says, and a sign-out to stay signed out, even
> when old replies arrive late.

### Only a reply to the current host and view changes what is shown

The view reads the session from its host port. Replacing the port, tearing
the view down and starting a sign-out each advance its revision. A reply
changes the view only if its read was started by the current port and
revision, the view is still mounted and no sign-out is in progress; an
error reply from an old read is dropped like any other.

```quint
type ReadPhase = ReadUnused | ReadPending | ReadDone
type HostReply = ReplyConnected | ReplyAbsent | ReplyUnavailable | ReplyAborted
type SessionRead = { readId: int, phase: ReadPhase, ownerPort: int, ownerRevision: int }
type CloudSessionView = { mounted: bool, port: int, revision: int, reads: List[SessionRead], signOutPort: int, signOutRevision: int, signOutAcknowledged: bool, account: int, unavailable: bool, suppressConnected: bool, lastViewRevision: int }
pure def unusedRead(readId: int): SessionRead = { readId: readId, phase: ReadUnused, ownerPort: 0, ownerRevision: 0 }
pure val initial: CloudSessionView = { mounted: true, port: 1, revision: 0, reads: List(unusedRead(1), unusedRead(2)), signOutPort: 0, signOutRevision: 0, signOutAcknowledged: false, account: 0, unavailable: false, suppressConnected: false, lastViewRevision: 0 }
pure def signingOut(v: CloudSessionView): bool = v.signOutPort != 0
pure def currentOwner(v: CloudSessionView, port: int, revision: int): bool = v.mounted and v.port == port and v.revision == revision
pure def readOf(v: CloudSessionView, readId: int): SessionRead = v.reads.select(r => r.readId == readId).nthOr(0, unusedRead(0))
pure def withRead(v: CloudSessionView, read: SessionRead): List[SessionRead] = v.reads.listMap(r => if (r.readId == read.readId) read else r)
pure def canReplacePort(v: CloudSessionView): bool = v.mounted
pure def replacePort(v: CloudSessionView): CloudSessionView = { ...v, port: v.port + 1, revision: v.revision + 1 }
pure def canUnmount(v: CloudSessionView): bool = v.mounted
pure def unmount(v: CloudSessionView): CloudSessionView = { ...v, mounted: false, revision: v.revision + 1 }
pure def canStartRead(v: CloudSessionView, readId: int): bool = v.mounted and not(signingOut(v)) and readOf(v, readId).readId == readId and readOf(v, readId).phase == ReadUnused
pure def startRead(v: CloudSessionView, readId: int): CloudSessionView = { ...v, reads: withRead(v, { readId: readId, phase: ReadPending, ownerPort: v.port, ownerRevision: v.revision }) }
pure def canReadReply(v: CloudSessionView, readId: int, hostReply: HostReply): bool = readOf(v, readId).readId == readId and readOf(v, readId).phase == ReadPending
pure def readReply(v: CloudSessionView, readId: int, hostReply: HostReply): CloudSessionView = {
  val read = readOf(v, readId)
  val resolved = { ...v, reads: withRead(v, { ...read, phase: ReadDone }) }
  val owns = currentOwner(v, read.ownerPort, read.ownerRevision) and not(signingOut(v))
  if (not(owns) or hostReply == ReplyAborted) resolved
  else if (hostReply == ReplyUnavailable) { ...resolved, unavailable: true, lastViewRevision: read.ownerRevision }
  else if (hostReply == ReplyAbsent) { ...resolved, account: 0, unavailable: false, suppressConnected: false, lastViewRevision: read.ownerRevision }
  else { ...resolved, account: if (v.suppressConnected) v.account else read.ownerPort, unavailable: false, lastViewRevision: read.ownerRevision }
}
pure val readIdValues = Set(1, 2)
pure def stepOnlyTheCurrentOwnerChangesTheView(before: CloudSessionView, after: CloudSessionView): bool =
  (after.account != before.account or after.unavailable != before.unavailable or after.suppressConnected != before.suppressConnected) implies
    (before.mounted and after.lastViewRevision == before.revision)
pure def sometimesSignedInShown(v: CloudSessionView): bool = v.account > 0 and v.revision > 0
pure def sometimesUnavailableShown(v: CloudSessionView): bool = v.unavailable
```

### A sign-out clears the account and keeps it cleared

Starting a sign-out fences every read in flight. The host's acknowledgement
counts only while the sign-out still belongs to the current port and
revision; joining it clears the shown account and suppresses a later
"connected" reply until the host reports no session. A sign-out that lost
its owner ends without touching the view.

```quint
pure def canStartSignOut(v: CloudSessionView): bool = v.mounted and not(signingOut(v))
pure def startSignOut(v: CloudSessionView): CloudSessionView = { ...v, signOutPort: v.port, signOutRevision: v.revision + 1, revision: v.revision + 1 }
pure def canSignOutReply(v: CloudSessionView, acknowledged: bool): bool = signingOut(v) and not(v.signOutAcknowledged)
pure def signOutReply(v: CloudSessionView, acknowledged: bool): CloudSessionView =
  if (acknowledged and currentOwner(v, v.signOutPort, v.signOutRevision)) { ...v, signOutAcknowledged: true }
  else { ...v, signOutPort: 0, signOutRevision: 0 }
pure def canJoinSignOut(v: CloudSessionView): bool = v.signOutAcknowledged
pure def joinSignOut(v: CloudSessionView): CloudSessionView = {
  val resolved = { ...v, signOutPort: 0, signOutRevision: 0, signOutAcknowledged: false }
  if (currentOwner(v, v.signOutPort, v.signOutRevision)) { ...resolved, account: 0, suppressConnected: true, lastViewRevision: v.revision } else resolved
}
pure def alwaysSuppressedAccountIsCleared(v: CloudSessionView): bool = v.suppressConnected implies v.account == 0
pure def alwaysAcknowledgedSignOutIsInProgress(v: CloudSessionView): bool = v.signOutAcknowledged implies signingOut(v)
pure def sometimesSignedOutStaysSignedOut(v: CloudSessionView): bool = v.suppressConnected and v.reads.select(r => r.phase == ReadDone).length() > 0
pure val fair_joinSignOut = "weak"
pure def leadsToSignOutSettles(v: CloudSessionView, later: CloudSessionView): bool = v.signOutAcknowledged implies not(later.signOutAcknowledged)
```

## Story: Use the cloud from an agent as configured

> As an agent operator, I want each model capability routed to the cloud
> only when I configured it, disconnecting to leave no cloud credentials
> behind, and a failed stream reported as failed.

### Each capability is routed to the cloud exactly when its flag is on

Routing is typed configuration with one flag per capability group:
embeddings, media, speech output and speech input. At initialization the
client registers exactly the groups whose flags are on, and nothing before
it is configured.

```quint
type CapabilityGroup = EmbeddingsGroup | MediaGroup | SpeechOutputGroup | SpeechInputGroup
type CloudRouting = { embeddings: bool, media: bool, speechOutput: bool, speechInput: bool }
pure def routesToCloud(routing: CloudRouting, group: CapabilityGroup): bool =
  if (group == EmbeddingsGroup) routing.embeddings else if (group == MediaGroup) routing.media else if (group == SpeechOutputGroup) routing.speechOutput else routing.speechInput
pure def registered(configured: bool, routing: CloudRouting, group: CapabilityGroup): bool = configured and routesToCloud(routing, group)
pure def lawRegisteredExactlyWhenEnabled(routing: CloudRouting, group: CapabilityGroup): bool = registered(true, routing, group) == routesToCloud(routing, group)
pure def lawNothingRegisteredBeforeConfiguration(routing: CloudRouting, group: CapabilityGroup): bool = not(registered(false, routing, group))
pure val routingValues = Set({ embeddings: true, media: false, speechOutput: true, speechInput: false }, { embeddings: false, media: true, speechOutput: false, speechInput: true }, { embeddings: false, media: false, speechOutput: false, speechInput: false })
```

### A disconnect reports success only after the cleared credentials are saved

Disconnecting clears the cloud credential and its configuration key first,
then saves the configuration. It answers success only when the save
succeeded; a failed save is reported as a failure, with the credential
already cleared in memory.

```quint
type DisconnectReply = DisconnectSucceeded | DisconnectFailed
pure def disconnectReply(saveSucceeded: bool): DisconnectReply = if (saveSucceeded) DisconnectSucceeded else DisconnectFailed
pure def lawSuccessMeansSaved(saveSucceeded: bool): bool = disconnectReply(saveSucceeded) == DisconnectSucceeded implies saveSucceeded
```

### A stream completes only with text and no error

A completion stream completes only when it delivered text and ended
without an error. An empty stream or an error, with or without a message,
fails, and partial text already shown stays shown.

```quint
type StreamResult = StreamCompleted | StreamFailed
type CompletionStream = { deliveredText: bool, endedInError: bool }
pure def streamResult(completionStream: CompletionStream): StreamResult = if (completionStream.deliveredText and not(completionStream.endedInError)) StreamCompleted else StreamFailed
pure def lawErrorNeverCompletes(completionStream: CompletionStream): bool = completionStream.endedInError implies streamResult(completionStream) == StreamFailed
pure def lawEmptyStreamNeverCompletes(completionStream: CompletionStream): bool = not(completionStream.deliveredText) implies streamResult(completionStream) == StreamFailed
pure val completionStreamValues = Set({ deliveredText: false, endedInError: false }, { deliveredText: true, endedInError: false }, { deliveredText: true, endedInError: true }, { deliveredText: false, endedInError: true })
```

### Warmup is sent once per endpoint and the debounce cache stays small

A warmup request goes out only when warmup is allowed and the endpoint is
not already in the current debounce cache. The cache holds at most two
endpoints, evicting the oldest, and empties when it expires, so the next
allowed request warms the endpoint again. A sent warmup keeps its place
whatever its outcome.

```quint
pure val warmupCacheSize = 2
pure def warmupSends(allowed: bool, endpoints: List[int], endpoint: int): bool = allowed and endpoints.select(e => e == endpoint).length() == 0
pure def warmupCacheAfter(allowed: bool, endpoints: List[int], endpoint: int): List[int] =
  if (not(warmupSends(allowed, endpoints, endpoint))) endpoints
  else (if (endpoints.length() >= warmupCacheSize) endpoints.tail() else endpoints).append(endpoint)
pure def lawWarmupOnlyWhenAllowedAndUncached(allowed: bool, endpoints: List[int], endpoint: int): bool =
  warmupSends(allowed, endpoints, endpoint) implies (allowed and endpoints.select(e => e == endpoint).length() == 0)
pure def lawWarmupCacheStaysSmall(allowed: bool, endpoints: List[int], endpoint: int): bool =
  endpoints.length() <= warmupCacheSize implies warmupCacheAfter(allowed, endpoints, endpoint).length() <= warmupCacheSize
pure def lawExpiredCacheWarmsAgain(endpoint: int): bool = warmupSends(true, List(), endpoint)
```
