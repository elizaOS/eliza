# Live speech session

A live session streams microphone frames to a speech recognizer and turns
each spoken segment into one final transcript. Frames and voice-activity
edges are forwarded in the order they were captured, as batches, and a
batch stays counted until its transport promise settles. Partial
transcripts are shown while a person speaks; only finals become turns. The
capture feeding it is [native capture](./microphoneSlot.md); per-turn
diagnostics are [timing](./timing.md).

## Story: Stream live transcription for each spoken segment

> As a person dictating live, I want each thing I say to arrive once, in
> order, and a stalled connection to fail clearly instead of buffering
> without end.

### The frame backlog is bounded and an overflow fails the session once

At most 960 frames are queued or in flight. A batch that would cross that
bound ends the session with one transport failure: every closed segment
still owed a final gets an empty one, and nothing more is accepted. A late
transport completion still releases its batch but cannot revive the
session.

```quint
type LiveSession = { queued: int, finished: bool, discarded: bool, overflowed: bool,
  expected: int, closed: int, finals: int, nulls: int, dropped: int, partials: int, turnsSent: int }
pure val initial: LiveSession = { queued: 0, finished: false, discarded: false, overflowed: false,
  expected: 0, closed: 0, finals: 0, nulls: 0, dropped: 0, partials: 0, turnsSent: 0 }
pure val frameBacklogLimit = 960
pure def canAcceptFrames(l: LiveSession, frames: int): bool = not(l.finished) and frames > 0
pure def acceptFrames(l: LiveSession, frames: int): LiveSession =
  if (l.queued + frames > frameBacklogLimit)
    { ...l, finished: true, overflowed: true, expected: 0, nulls: l.nulls + l.expected }
  else { ...l, queued: l.queued + frames }
pure val framesValues = Set(0, 1, 480, 961)
pure def canSettleBatch(l: LiveSession, frames: int): bool = frames > 0 and frames <= l.queued
pure def settleBatch(l: LiveSession, frames: int): LiveSession = { ...l, queued: l.queued - frames }
pure def alwaysBacklogBounded(l: LiveSession): bool = l.queued >= 0 and l.queued <= frameBacklogLimit
pure def alwaysOverflowSettlesSegments(l: LiveSession): bool =
  l.overflowed implies l.finished and l.expected == 0 and not(l.discarded)
pure def stepFinishedSessionStaysFinished(before: LiveSession, after: LiveSession): bool =
  before.finished implies after.finished and after.overflowed == before.overflowed and after.discarded == before.discarded
pure def sometimesOverflowNullsSegments(l: LiveSession): bool = l.overflowed and l.nulls > 0
```

### Each closed segment gets exactly one final

Closing a segment owes it one final transcript. A final settles the oldest
owed segment and becomes one turn. A cancelled session drops what was
still owed and publishes nothing more. Every closed segment is accounted
for once: final, empty after an overflow, dropped on cancel, or still owed.

```quint
pure def canCloseSegment(l: LiveSession): bool = not(l.finished)
pure def closeSegment(l: LiveSession): LiveSession = { ...l, expected: l.expected + 1, closed: l.closed + 1 }
pure def canDeliverFinal(l: LiveSession): bool = not(l.finished) and l.expected > 0
pure def deliverFinal(l: LiveSession): LiveSession =
  { ...l, expected: l.expected - 1, finals: l.finals + 1, turnsSent: l.turnsSent + 1 }
pure def canCancelSession(l: LiveSession): bool = not(l.finished)
pure def cancelSession(l: LiveSession): LiveSession =
  { ...l, finished: true, discarded: true, expected: 0, dropped: l.dropped + l.expected }
pure def alwaysOneFinalPerSegment(l: LiveSession): bool =
  l.expected >= 0 and l.finals >= 0 and l.nulls >= 0 and l.dropped >= 0 and
  l.finals + l.nulls + l.dropped + l.expected == l.closed
pure def alwaysCancelFencesResults(l: LiveSession): bool =
  l.discarded implies l.finished and l.expected == 0 and not(l.overflowed)
pure def sometimesFinalDelivered(l: LiveSession): bool = l.finals > 1 and l.expected > 0
pure def sometimesLateBatchAfterCancel(l: LiveSession): bool = l.discarded and l.queued > 0
```

### Partial transcripts are for display only

A partial transcript updates what the person sees while speaking. It never
becomes a turn; only finals do.

```quint
pure def canShowPartial(l: LiveSession): bool = not(l.finished)
pure def showPartial(l: LiveSession): LiveSession = { ...l, partials: l.partials + 1 }
pure def alwaysOnlyFinalsAreTurns(l: LiveSession): bool = l.turnsSent == l.finals
pure def stepPartialSendsNothing(before: LiveSession, via: str, after: LiveSession): bool =
  via == "showPartial" implies after.turnsSent == before.turnsSent
pure def sometimesPartialShown(l: LiveSession): bool = l.partials > 0 and l.turnsSent > 0
```

### A finished session releases every retained batch

When transport promises keep settling, a finished session eventually holds
no queued frames.

```quint
pure val fair_settleBatch = "weak"
pure def leadsToRetainedBatchesSettle(l: LiveSession, later: LiveSession): bool =
  l.finished implies later.queued == 0
```
