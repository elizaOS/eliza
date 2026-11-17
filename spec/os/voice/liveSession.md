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
type LiveSession = { queued: int, finished: bool, discarded: bool, overflowed: bool, timedOut: bool,
  expected: int, closed: int, finals: int, nulls: int, dropped: int, partials: int, turnsSent: int }
pure val initial: LiveSession = { queued: 0, finished: false, discarded: false, overflowed: false, timedOut: false,
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
  (l.overflowed or l.timedOut) implies l.finished and l.expected == 0 and not(l.discarded) and not(l.overflowed and l.timedOut)
pure def stepFinishedSessionStaysFinished(before: LiveSession, after: LiveSession): bool =
  before.finished implies after.finished and after.overflowed == before.overflowed and after.discarded == before.discarded and
    after.timedOut == before.timedOut
pure def sometimesOverflowNullsSegments(l: LiveSession): bool = l.overflowed and l.nulls > 0
```

### A segment exchange that does not answer within 8 seconds fails the session once

Each batch of frames and edges, and the final close, goes to the
resident's live segment route as one exchange that the host bounds at 8
seconds ([on-device speech](./localSpeech.md)). An exchange still
unanswered at its deadline ends the session with one transport failure,
as an overflow does: every closed segment still owed a final gets an
empty one, queued audio is dropped and the request in flight is
cancelled. A session is warmed with an empty exchange before the
microphone opens. Frames and edges captured after an explicit stop are
never sent.

```quint
pure def canTimeOutExchange(l: LiveSession, waitedMs: int): bool = not(l.finished) and l.queued > 0 and waitedMs >= 8000
pure def timeOutExchange(l: LiveSession, waitedMs: int): LiveSession =
  { ...l, finished: true, timedOut: true, expected: 0, nulls: l.nulls + l.expected }
pure val waitedMsValues = Set(0, 7999, 8000)
pure def stepExchangeTimeoutNeedsDeadline(before: LiveSession, via: str, after: LiveSession): bool =
  (not(before.timedOut) and after.timedOut) implies via == "timeOutExchange" and before.queued > 0
pure def sometimesExchangeTimedOut(l: LiveSession): bool = l.timedOut and l.nulls > 0
```

### Each closed segment gets exactly one final

Closing a segment owes it one final transcript. A final settles the oldest
owed segment and becomes one turn. A cancelled session drops queued audio
and what was still owed, cancels the exchange in flight and publishes
nothing more. Every closed segment is accounted
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
  l.discarded implies l.finished and l.expected == 0 and not(l.overflowed) and not(l.timedOut)
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

## Story: Cut live speech into segments and recognize it on the device

> As a person speaking to my device, I want a short pause inside a
> sentence to stay in one segment, and recognition to use the device's own
> recognizer only when its model is really there.

### A segment opens after two speech windows and closes only after its hangover of silence

Voice activity arrives as one probability per 32 ms window. A segment
opens after two consecutive windows at or above 0.5, and closes only after
a run of consecutive windows below 0.35 as long as its hangover: by
default 16 windows (about 512 ms); a conversation that submits at a
shorter pause passes its own hangover. Any window at or above 0.35 inside
a segment restarts the hangover. While no segment is open the last 10
windows are kept, so the first syllable reaches the recognizer.

```quint
type VadGate = { speaking: bool, above: int, below: int }
pure val vadPrerollWindows = 10
pure def vadAccept(gate: VadGate, endWindows: int, probabilityPct: int): VadGate =
  if (not(gate.speaking))
    (if (probabilityPct >= 50 and gate.above + 1 >= 2) { speaking: true, above: 0, below: 0 }
     else { ...gate, above: if (probabilityPct >= 50) gate.above + 1 else 0 })
  else if (probabilityPct < 35 and gate.below + 1 >= endWindows) { speaking: false, above: 0, below: 0 }
  else { ...gate, below: if (probabilityPct < 35) gate.below + 1 else 0 }
pure val gateValues = Set({ speaking: false, above: 0, below: 0 }, { speaking: false, above: 1, below: 0 },
  { speaking: true, above: 0, below: 0 }, { speaking: true, above: 0, below: 7 }, { speaking: true, above: 0, below: 15 })
pure val endWindowsValues = Set(8, 16)
pure val probabilityPctValues = Set(0, 34, 35, 49, 50, 100)
pure def lawOneLoudWindowOpensNothing(endWindows: int, probabilityPct: int): bool =
  not(vadAccept({ speaking: false, above: 0, below: 0 }, endWindows, probabilityPct).speaking)
pure def lawSegmentOpensOnSpeech(gate: VadGate, endWindows: int, probabilityPct: int): bool =
  not(gate.speaking) and vadAccept(gate, endWindows, probabilityPct).speaking implies probabilityPct >= 50 and gate.above >= 1
pure def lawHangoverKeepsSegmentOpen(gate: VadGate, endWindows: int, probabilityPct: int): bool =
  gate.speaking and gate.below + 1 < endWindows implies vadAccept(gate, endWindows, probabilityPct).speaking
pure def lawSpeechRestartsHangover(gate: VadGate, endWindows: int, probabilityPct: int): bool =
  gate.speaking and probabilityPct >= 35 implies vadAccept(gate, endWindows, probabilityPct) == { ...gate, below: 0 }
```

### The device's recognizer is used only while its model is known to be installed

Whether the on-device recognizer has a language's model is learned by
asking the recognition service. An installed answer is kept until the
language is demoted; an absent answer for 60 seconds, so a model
installed later is seen; a probe the service did not answer reads as
unavailable and is asked again after 30 seconds. A late answer from an
older probe never overwrites the answer of a newer one, a non-answer never
replaces an answer still in force, and nothing but its own expiry ends a
demotion.

```quint
type RecognizerKnown = KnownUnknown | KnownInstalled | KnownAbsent | KnownUnanswered | KnownDemoted
type ProbeAnswer = AnswerInstalled | AnswerAbsent | AnswerUnanswered
type RecognizerEntry = { known: RecognizerKnown, until: int, ticket: int }
pure val recognizerForeverMs = 1000000000000
pure def recognizerInForce(entry: RecognizerEntry, now: int): bool = entry.known != KnownUnknown and now < entry.until
pure def recordProbe(entry: RecognizerEntry, answer: ProbeAnswer, ticket: int, now: int): RecognizerEntry =
  if (recognizerInForce(entry, now) and entry.known == KnownDemoted) entry
  else if (entry.ticket > ticket and (entry.known == KnownInstalled or entry.known == KnownAbsent)) entry
  else if (recognizerInForce(entry, now) and answer == AnswerUnanswered and entry.known != KnownUnanswered) entry
  else if (answer == AnswerInstalled) { known: KnownInstalled, until: recognizerForeverMs, ticket: ticket }
  else if (answer == AnswerAbsent) { known: KnownAbsent, until: now + 60000, ticket: ticket }
  else { known: KnownUnanswered, until: now + 30000, ticket: ticket }
pure def recognizerAvailable(entry: RecognizerEntry, now: int): bool = recognizerInForce(entry, now) and entry.known == KnownInstalled
pure val entryValues = Set({ known: KnownUnknown, until: 0, ticket: 0 }, { known: KnownInstalled, until: recognizerForeverMs, ticket: 2 },
  { known: KnownAbsent, until: 60000, ticket: 2 }, { known: KnownUnanswered, until: 30000, ticket: 1 }, { known: KnownDemoted, until: 90000, ticket: 0 })
pure val ticketValues = Set(1, 2, 3)
pure val nowValues = Set(0, 59999, 60000, 90000)
pure def lawOlderAnswerNeverOverwritesNewer(entry: RecognizerEntry, answer: ProbeAnswer, ticket: int, now: int): bool =
  entry.ticket > ticket and (entry.known == KnownInstalled or entry.known == KnownAbsent) implies recordProbe(entry, answer, ticket, now) == entry
pure def lawNonAnswerNeverGrants(entry: RecognizerEntry, ticket: int, now: int): bool =
  recognizerAvailable(recordProbe(entry, AnswerUnanswered, ticket, now), now) implies recognizerAvailable(entry, now)
pure def lawDemotionHolds(entry: RecognizerEntry, answer: ProbeAnswer, ticket: int, now: int): bool =
  entry.known == KnownDemoted and recognizerInForce(entry, now) implies not(recognizerAvailable(recordProbe(entry, answer, ticket, now), now))
pure def lawAbsentIsAskedAgain(entry: RecognizerEntry, ticket: int, now: int): bool =
  recordProbe(entry, AnswerAbsent, ticket, now) != entry implies recordProbe(entry, AnswerAbsent, ticket, now) == { known: KnownAbsent, until: now + 60000, ticket: ticket }
```
