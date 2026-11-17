# Conversation selection and message loading

A client shows one active conversation. Selecting another saves the draft
of the one it leaves and loads the newest messages of the one it enters; a
search result can instead load the messages around one message. Each load
is fenced by the conversation that owns the message list when it was
admitted. Full message values, overlay reconciliation and cache eviction
are separate owners; this spec owns which load may publish and what a
failed selection restores. The [runtime client](./runtimeClient.md) carries
the requests, and the [client turn controller](./conversation.md) owns
sending in the selected conversation.

## Story: Load the messages of the conversation I am looking at

> As a user switching quickly between conversations, I only ever see the
> messages of the conversation I chose last.

### Only the current load of the conversation that owns the list may publish

Claiming a conversation makes it the active owner of the message list and
aborts the load in flight. A load is admitted for the active conversation; a
newest load may take ownership of the list, an around load needs the list
to be owned already. A reply publishes rows only while its load is still
the fenced, unaborted load of the same owner and generation. An around load
publishes after a callback that can claim another conversation first, so it
checks again before publishing.

```quint
type LoadKind = Newest | Around
type LoadPhase = LoadPending | LoadCallback | LoadList | LoadDone
type LoadOutcome = LoadOk | LoadMissing | LoadFailed
type SelectionResult = SelectOk | SelectMissing | SelectForbidden | SelectFailed
type LoadRequest = { id: int, target: int, kind: LoadKind, phase: LoadPhase, ownerEpoch: int, requestEpoch: int, aborted: bool }
type SelectionCall = { callId: int, epoch: int, target: int, previous: int, waiting: bool }
type ConversationLoad = { active: int, owner: int, ownerEpoch: int, requestEpoch: int, fence: int, nextRequest: int, requests: List[LoadRequest],
  visible: int, loaded: int, cached: Set[int], lastPublished: int,
  selectionEpoch: int, nextCall: int, calls: List[SelectionCall], composer: int, drafts: int -> int, notices: int, lastReply: int }
pure val noRequest: LoadRequest = { id: 0, target: 0, kind: Newest, phase: LoadDone, ownerEpoch: -1, requestEpoch: -1, aborted: true }
pure val noCall: SelectionCall = { callId: 0, epoch: -1, target: 0, previous: 0, waiting: false }
pure val initial: ConversationLoad = { active: 1, owner: 1, ownerEpoch: 1, requestEpoch: 0, fence: 0, nextRequest: 1, requests: List(),
  visible: 1, loaded: 1, cached: Set(), lastPublished: 0,
  selectionEpoch: 0, nextCall: 1, calls: List(), composer: 1, drafts: Map(1 -> 1, 2 -> 2, 3 -> 3), notices: 0, lastReply: 0 }
pure def requestOf(c: ConversationLoad, id: int): LoadRequest = c.requests.select(r => r.id == id).nthOr(0, noRequest)
pure def loadCurrent(c: ConversationLoad, id: int): bool = {
  val r = requestOf(c, id)
  r.id > 0 and c.fence == id and not(r.aborted) and c.active == r.target and c.owner == r.target and c.ownerEpoch == r.ownerEpoch and c.requestEpoch == r.requestEpoch
}
pure def abortFenced(c: ConversationLoad): List[LoadRequest] = c.requests.listMap(r => if (r.id == c.fence) { ...r, aborted: true } else r)
pure def claimedBy(room: int, c: ConversationLoad): ConversationLoad =
  { ...c, active: room, owner: room, fence: 0, requests: abortFenced(c), requestEpoch: c.requestEpoch + 1,
    ownerEpoch: c.ownerEpoch + (if (c.owner != room or room == 0) 1 else 0) }
pure def withPhase(id: int, phase: LoadPhase, c: ConversationLoad): ConversationLoad =
  { ...c, requests: c.requests.listMap(r => if (r.id == id) { ...r, phase: phase } else r) }
pure def published(id: int, c: ConversationLoad): ConversationLoad = {
  val r = requestOf(c, id)
  { ...withPhase(id, LoadDone, c), visible: r.target, loaded: r.target, lastPublished: id,
    cached: if (r.kind == Newest) c.cached.union(Set(r.target)) else c.cached }
}
pure def claimRoom(c: ConversationLoad, room: int): ConversationLoad = claimedBy(room, c)
pure def canAdmitLoad(c: ConversationLoad, room: int, kind: LoadKind): bool =
  c.active == room and room != 0 and (kind == Newest or c.owner == room)
pure def admitLoad(c: ConversationLoad, room: int, kind: LoadKind): ConversationLoad = {
  val generation = c.requestEpoch + (if (kind == Newest) 2 else 1)
  val ownerEpoch = c.ownerEpoch + (if (kind == Newest and c.owner != room) 1 else 0)
  { ...c, owner: room, fence: c.nextRequest, nextRequest: c.nextRequest + 1, ownerEpoch: ownerEpoch, requestEpoch: generation,
    requests: abortFenced(c).append({ id: c.nextRequest, target: room, kind: kind, phase: LoadPending, ownerEpoch: ownerEpoch, requestEpoch: generation, aborted: false }),
    visible: if (kind == Newest) room else c.visible,
    loaded: if (kind == Newest and c.loaded != room and not(c.cached.contains(room))) 0 else c.loaded }
}
pure def canLoadReply(c: ConversationLoad, id: int): bool = requestOf(c, id).phase == LoadPending and requestOf(c, id).id > 0
pure def loadReply(c: ConversationLoad, id: int, loadOutcome: LoadOutcome): ConversationLoad = {
  val r = requestOf(c, id)
  if (not(loadCurrent(c, id))) withPhase(id, LoadDone, c)
  else if (loadOutcome == LoadOk and r.kind == Around) withPhase(id, LoadCallback, c)
  else if (loadOutcome == LoadOk) published(id, c)
  else if (loadOutcome == LoadMissing and r.kind == Newest) withPhase(id, LoadList, c)
  else withPhase(id, LoadDone, c)
}
pure def canFinishAround(c: ConversationLoad, id: int): bool = requestOf(c, id).phase == LoadCallback and requestOf(c, id).id > 0
pure def finishAround(c: ConversationLoad, id: int): ConversationLoad =
  if (loadCurrent(c, id)) published(id, c) else withPhase(id, LoadDone, c)
pure def canFinalizeLoad(c: ConversationLoad, id: int): bool = requestOf(c, id).phase == LoadDone and requestOf(c, id).id > 0
pure def finalizeLoad(c: ConversationLoad, id: int): ConversationLoad =
  { ...c, requests: c.requests.select(r => r.id != id), fence: if (c.fence == id) 0 else c.fence }
pure val roomValues = Set(0, 1, 2, 3)
pure val idValues = Set(1, 2, 3)
pure def alwaysFenceNamesALiveRequest(c: ConversationLoad): bool =
  c.fence >= 0 and c.fence < c.nextRequest and c.requests.every(r => r.id > 0 and r.id < c.nextRequest) and
  (c.fence != 0 implies c.requests.some(r => r.id == c.fence))
pure def stepOnlyCurrentLoadPublishes(before: ConversationLoad, after: ConversationLoad): bool =
  after.lastPublished != before.lastPublished implies loadCurrent(before, after.lastPublished)
pure def sometimesAroundLoadPublished(c: ConversationLoad): bool = c.lastPublished > 0 and requestOf(c, c.lastPublished).kind == Around
pure def sometimesReentrantClaimRefusesAround(c: ConversationLoad): bool =
  c.requests.some(r => r.kind == Around and r.phase == LoadDone and r.aborted) and c.lastPublished == 0
```

### A missing conversation sends the list to the fallback only if it still owns it

When the newest load finds the conversation gone, the client reads the
conversation list and claims a fallback, but only if that load is still
current; a conversation claimed meanwhile keeps the list.

```quint
pure def canListReply(c: ConversationLoad, id: int): bool = requestOf(c, id).phase == LoadList and requestOf(c, id).id > 0
pure def listReply(c: ConversationLoad, id: int, fallback: int): ConversationLoad =
  if (loadCurrent(c, id)) { ...withPhase(id, LoadDone, claimedBy(fallback, c)), visible: 0, loaded: 0, cached: c.cached.exclude(Set(requestOf(c, id).target)) }
  else withPhase(id, LoadDone, c)
pure val fallbackValues = Set(0, 2, 3)
pure def stepFallbackOnlyFromCurrentLoad(before: ConversationLoad, via: str, after: ConversationLoad): bool =
  (via == "listReply" and after.active != before.active) implies before.requests.some(r => r.phase == LoadList and loadCurrent(before, r.id))
pure def sometimesMissingConversationFallsBack(c: ConversationLoad): bool = c.visible == 0 and c.loaded == 0 and c.active != 1
```

## Story: Switch conversations without losing a draft

> As a user, the text I was typing stays with its conversation when I
> switch away and back, and a conversation that fails to open returns me to
> the one I left.

### Leaving a conversation saves its draft and entering one restores its own

Selecting a different conversation stores the composer text under the
conversation being left, claims the new one and fills the composer with its
saved draft. Selecting the conversation already loaded only advances the
selection epoch.

```quint
pure def draftOf(drafts: int -> int, room: int): int = if (drafts.keys().contains(room)) drafts.get(room) else 0
pure def canChooseConversation(c: ConversationLoad, target: int): bool = target > 0
pure def switchedTo(target: int, c: ConversationLoad): ConversationLoad = {
  val saved = if (c.active > 0) c.drafts.put(c.active, c.composer) else c.drafts
  { ...claimedBy(target, c), selectionEpoch: c.selectionEpoch + 1, nextCall: c.nextCall + 1, drafts: saved, composer: draftOf(saved, target),
    calls: c.calls.append({ callId: c.nextCall, epoch: c.selectionEpoch + 1, target: target, previous: c.active, waiting: true }) }
}
pure def chooseConversation(c: ConversationLoad, target: int): ConversationLoad =
  if (target == c.active and c.loaded == c.active) { ...c, selectionEpoch: c.selectionEpoch + 1 }
  else switchedTo(target, c)
pure val targetValues = Set(0, 1, 2, 3)
pure def stepLeavingSavesDraft(before: ConversationLoad, via: str, after: ConversationLoad): bool =
  (via == "chooseConversation" and after.active != before.active) implies
    ((before.active > 0 implies draftOf(after.drafts, before.active) == before.composer) and after.composer == draftOf(after.drafts, after.active))
pure def sometimesDraftCarriedAcrossSwitch(c: ConversationLoad): bool = c.calls.length() > 0 and c.composer != c.active
```

### Only the latest selection's reply can change the conversation, and a failure returns to the previous one

A selection's load reply counts only if no newer selection happened since.
If the new conversation is forbidden or fails to load, the client claims
the previous conversation again and restores its draft; with no previous
conversation it shows a notice. A missing conversation is left to list
recovery. An outdated reply changes neither the active conversation nor the
composer. Selection calls are numbered from one, and every call awaiting
its reply has a number already issued and an epoch no later than the
current one.

```quint
pure def callOf(c: ConversationLoad, callId: int): SelectionCall = c.calls.select(k => k.callId == callId).nthOr(0, noCall)
pure def canSelectionReply(c: ConversationLoad, callId: int): bool = callOf(c, callId).waiting
pure def selectionReply(c: ConversationLoad, callId: int, selectionResult: SelectionResult): ConversationLoad = {
  val call = callOf(c, callId)
  val resolved = { ...c, calls: c.calls.select(k => k.callId != callId), lastReply: callId }
  if (call.epoch != c.selectionEpoch or selectionResult == SelectOk or selectionResult == SelectMissing) resolved
  else if (call.previous > 0) { ...claimedBy(call.previous, resolved), composer: draftOf(c.drafts, call.previous) }
  else { ...resolved, notices: c.notices + 1 }
}
pure val callIdValues = Set(1, 2, 3)
pure def stepOutdatedSelectionChangesNothing(before: ConversationLoad, via: str, after: ConversationLoad): bool =
  (via == "selectionReply" and callOf(before, after.lastReply).epoch != before.selectionEpoch) implies
    (after.active == before.active and after.composer == before.composer)
pure def stepFailedSelectionReturnsToPrevious(before: ConversationLoad, via: str, after: ConversationLoad): bool =
  (via == "selectionReply" and after.active != before.active) implies
    (callOf(before, after.lastReply).epoch == before.selectionEpoch and after.active == callOf(before, after.lastReply).previous and after.composer == draftOf(before.drafts, after.active))
pure def alwaysCallsAreIssued(c: ConversationLoad): bool = c.nextCall > 0 and c.calls.every(k => k.callId > 0 and k.callId < c.nextCall and k.epoch <= c.selectionEpoch and k.waiting)
pure def sometimesFailedSelectionRestored(c: ConversationLoad): bool = c.lastReply > 0 and c.active == 1 and c.composer == 1 and c.loaded == 1 and c.ownerEpoch > 2
pure def sometimesNoticeWithoutPrevious(c: ConversationLoad): bool = c.notices > 0
```

## Story: Restore a long conversation without duplicates or an endless read

> As a user reopening a long conversation, I see its recent messages and as
> much older history as the client keeps, oldest first, with no message
> twice, and I am told when older history was left on the agent.

### Paging back continues only while the agent says more remain and the page added something

After the recent window, the client asks for the page older than its oldest
message. It asks again only when the agent reported that more remain, the
last page added a message the client did not already have, and the client
holds fewer messages than its bound. A page without that report, a refused
cursor, or a page that adds nothing ends the read as partial; reaching the
bound ends it as partial; an agent that reports none remain ends it
complete.

```quint
type PagingStep = PageAgain | PagingComplete | PagingPartial
type PageReply = { reported: bool, hasMore: bool, fresh: int }
pure def pagingStep(reply: PageReply, held: int, bound: int): PagingStep =
  if (held >= bound or not(reply.reported)) PagingPartial
  else if (not(reply.hasMore)) PagingComplete
  else if (reply.fresh <= 0) PagingPartial
  else PageAgain
pure val replyValues = Set({ reported: true, hasMore: true, fresh: 3 }, { reported: true, hasMore: true, fresh: 0 }, { reported: true, hasMore: false, fresh: 2 }, { reported: false, hasMore: true, fresh: 3 })
pure val heldValues = Set(0, 200, 2000)
pure val boundValues = Set(2000)
pure def lawPagingAgainNeedsReportedProgress(reply: PageReply, held: int, bound: int): bool =
  pagingStep(reply, held, bound) == PageAgain implies (reply.reported and reply.hasMore and reply.fresh > 0 and held < bound)
pure def lawSilentAgentEndsThePaging(reply: PageReply, held: int, bound: int): bool =
  not(reply.reported) implies pagingStep(reply, held, bound) == PagingPartial
```

### A replaced message is confirmed only by a count of removed messages

The client replaces one of the user's own messages by truncating at it,
inclusively, after rereading it unchanged in the current conversation. The
replacement is confirmed only by a reply that removed at least one message.
Once the truncation was sent, any other ending is unknown: the client
reloads the conversation to check and never sends the truncation again.

```quint
type TruncationOutcome = TruncationConfirmed | TruncationUnknown | TruncationNotSent
pure def truncationOutcome(sent: bool, replyOk: bool, removed: int): TruncationOutcome =
  if (not(sent)) TruncationNotSent else if (replyOk and removed >= 1) TruncationConfirmed else TruncationUnknown
pure val removedValues = Set(0, 1, 3)
pure def lawNothingRemovedIsNotConfirmed(sent: bool, replyOk: bool): bool = truncationOutcome(sent, replyOk, 0) != TruncationConfirmed
pure def lawSentTruncationIsNeverNotSent(replyOk: bool, removed: int): bool = truncationOutcome(true, replyOk, removed) != TruncationNotSent
```
