# Telegram delivery, pairing, and history

Pinned task boards, compact turn progress indicators, owner pairing, world
ownership, and personal account history enforce strict single-message,
fail-closed, and bounded-query guarantees.

## Story: Keep a pinned task board or progress status as one message across edits, deletions, and restarts

> As a Telegram user, I want repeated task-board or progress updates to edit
> the existing message in place, tolerate unchanged-text responses without
> reposting, survive host restarts, and post a replacement only when no message
> exists or the user deleted it.

### A slot edits in place while visible, tolerates unchanged text, and reposts only after absence or deletion

Each managed slot tracks whether it is a pinned task board or an unpinned
progress status, whether its message is currently visible in the chat, the
stored provider message identifier, whether the message is pinned, the latest
shown text revision, and monotone counters for posts, edits, unchanged-text
edits, and user deletions. Updating a visible slot edits the stored message in
place without posting a duplicate and records an unchanged edit when the new
text equals the shown text. Updating when the slot is absent or after a user
deletion posts a new message, assigns it the next post number, pins it when the
slot is a task board, and records a failed edit attempt beforehand when a
stale stored identifier existed. Host restarts leave the durable stored
identifier and chat state intact. User deletion hides a visible message, clears
its pin, and increments the deletion count. Total posts equal the deletion
count while hidden and one plus the deletion count while visible, so total
posts never exceed one plus the number of deletions; every visible slot holds
the latest post identifier, every visible task board stays pinned, and the
post count never decreases.

```quint
type TelegramSlotKind = BoardSlot | ProgressSlot
type TelegramSlotState = {
  kind: TelegramSlotKind,
  visible: bool,
  storedId: int,
  pinned: bool,
  shownText: int,
  posts: int,
  edits: int,
  unchangedEdits: int,
  deletes: int
}
pure val initial: TelegramSlotState = {
  kind: BoardSlot,
  visible: false,
  storedId: 0,
  pinned: false,
  shownText: 0,
  posts: 0,
  edits: 0,
  unchangedEdits: 0,
  deletes: 0
}
pure val textValues = Set(1, 2)
pure val kindValues = Set(BoardSlot, ProgressSlot)
pure def canSelectSlotKind(s: TelegramSlotState, kind: TelegramSlotKind): bool =
  s.posts == 0 and s.storedId == 0 and not(s.visible)
pure def selectSlotKind(s: TelegramSlotState, kind: TelegramSlotKind): TelegramSlotState =
  { ...s, kind: kind }
pure def canUpdateSlot(s: TelegramSlotState, text: int): bool =
  text > 0 and s.posts < 1000 and s.edits < 1000 and s.unchangedEdits < 1000
pure def updateSlot(s: TelegramSlotState, text: int): TelegramSlotState =
  if (s.visible and s.storedId > 0)
    {
      ...s,
      shownText: text,
      edits: s.edits + 1,
      unchangedEdits: if (s.shownText == text) s.unchangedEdits + 1 else s.unchangedEdits
    }
  else
    {
      ...s,
      visible: true,
      storedId: s.posts + 1,
      pinned: s.kind == BoardSlot,
      shownText: text,
      posts: s.posts + 1,
      edits: if (s.storedId > 0) s.edits + 1 else s.edits
    }
pure def canRestartHost(s: TelegramSlotState): bool = true
pure def restartHost(s: TelegramSlotState): TelegramSlotState = s
pure def canUserDeleteMessage(s: TelegramSlotState): bool =
  s.visible and s.deletes < 1000
pure def userDeleteMessage(s: TelegramSlotState): TelegramSlotState =
  { ...s, visible: false, pinned: false, deletes: s.deletes + 1 }
pure def alwaysPostsBoundedByDeletes(s: TelegramSlotState): bool =
  s.posts == s.deletes + (if (s.visible) 1 else 0) and s.posts <= 1 + s.deletes and s.posts >= 0 and s.deletes >= 0 and s.edits >= 0 and s.unchangedEdits >= 0
pure def alwaysVisibleHasStoredId(s: TelegramSlotState): bool =
  s.visible implies (s.storedId > 0 and s.storedId == s.posts)
pure def alwaysBoardPinnedWhenVisible(s: TelegramSlotState): bool =
  (s.kind == BoardSlot and s.visible) implies s.pinned
pure def stepPostsNeverDecrease(before: TelegramSlotState, after: TelegramSlotState): bool =
  after.posts >= before.posts
pure def sometimesEditThenDeleteReposts(s: TelegramSlotState): bool =
  s.visible and s.posts == 2 and s.edits >= 2 and s.unchangedEdits >= 1 and s.deletes == 1
pure val eval_witness_sometimesEditThenDeleteReposts = (
  ("updateSlot", 1),
  ("updateSlot", 1),
  ("restartHost"),
  ("userDeleteMessage"),
  ("updateSlot", 2)
)
```

## Story: Enforce fail-closed owner pairing, canonical world ownership, and bounded history queries

> As a Telegram deployment owner, I want pairing commands rate-limited and
> fail-closed, world ownership granted solely to the configured canonical owner,
> and personal account history queries validated strictly before fetching.

### Owner pairing fails closed on rate limit or missing backend, arbitrary senders never own a world, and history rejects cursors

Owner pairing allows at most five attempts within a sliding window and requires
both a reachable backend verification service and a valid six-digit code. World
ownership grants the `OWNER` role only when a canonical deployment owner is
configured and the entity matches that canonical owner; arbitrary DM senders and
group creators never receive world ownership. Personal Telegram account history
queries always reject cursor pagination, require any explicit limit to be at
least one, and require any `after` timestamp to precede `before` when both are
present.

```quint
pure val maxPairAttempts: int = 5
pure def pairCommandAllowed(attemptsInWindow: int, backendReachable: bool, codeValid: bool): bool =
  attemptsInWindow >= 0 and attemptsInWindow < maxPairAttempts and backendReachable and codeValid
pure def worldOwnerGranted(hasCanonicalOwner: bool, senderIsCanonicalOwner: bool): bool =
  hasCanonicalOwner and senderIsCanonicalOwner
pure def historyQueryValid(hasCursor: bool, hasLimit: bool, limitValue: int, hasAfter: bool, hasBefore: bool, afterBeforeOrdered: bool): bool =
  not(hasCursor) and (hasLimit implies limitValue >= 1) and ((hasAfter and hasBefore) implies afterBeforeOrdered)
pure val attemptsInWindowValues = Set(0, 4, 5, 6)
pure val limitValueValues = Set(0, 1, 50)
pure def lawPairRateLimitDeniesSixthAttempt(attemptsInWindow: int, backendReachable: bool, codeValid: bool): bool =
  attemptsInWindow >= maxPairAttempts implies not(pairCommandAllowed(attemptsInWindow, backendReachable, codeValid))
pure def lawUnreachableBackendFailsClosed(attemptsInWindow: int, codeValid: bool): bool =
  not(pairCommandAllowed(attemptsInWindow, false, codeValid))
pure def lawArbitrarySenderNeverOwnsWorld(hasCanonicalOwner: bool): bool =
  not(worldOwnerGranted(hasCanonicalOwner, false))
pure def lawHistoryCursorRejected(hasLimit: bool, limitValue: int, hasAfter: bool, hasBefore: bool, afterBeforeOrdered: bool): bool =
  not(historyQueryValid(true, hasLimit, limitValue, hasAfter, hasBefore, afterBeforeOrdered))
```
