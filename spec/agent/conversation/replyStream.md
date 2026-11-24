# Reply stream

`POST /api/conversations/:id/messages/stream` (Root) takes the same body as
the buffered send of [turns](./turns.md) and pushes the reply as it is
written, one frame after another over the private socket or loopback
server-sent events; the transport (`access/transport.md`) owns the
framing and its heartbeats. The frames are:

| Frame | Carries |
|---|---|
| `token` | `text` (an append), `fullText` (the whole text so far: a replace), or both (an append with a snapshot); `provisional: true` while some of the text may still be taken back |
| `acknowledgment` | `{text}`: the turn's brief cue that it heard the request ([planning](./planning.md)), at most once, never part of the text; shown and spoken |
| `status` | `{activity}`: what the turn is doing, display only |
| `tool` | `{name, label}`: a tool the turn runs and its label for the owner, `Using <app>` or `Working` ([planning](./planning.md)), display only |
| `reply_ready` | `{fullText, actionResults}`: the stored reply ahead of the terminal frame |
| `done` | `{fullText, messageId, userMessageId, agentName, actionResults, taskChoices?, failureKind?, cloudCode?, planAction?, retryAfterMs?, cutOffEffect?}`, with Cloud's own funding code, the fix, live wait and negotiated effect marker of [turns](./turns.md) |
| `error` | `{code, message}`: the turn left no reply |

One machine follows one request. The turn itself (admission, deadline,
Stop, the stored reply and its kind) is the [turns](./turns.md) machine's;
this one decides which frames the request writes, in which order, and
when the stream ends. Text is UTF-16 units, as in core's
[stream units](../../core/streamUnits.md).

A reader decodes each frame type it knows strictly: a field it does not
know, or a field of the wrong kind, fails the stream as
`REPLY_STREAM_PROTOCOL`. A frame whose `type` it does not know is skipped
and never ends the stream, so new information is added as a new frame
type, which an older reader passes over; a new field on a known frame
would still fail it. The tool frame's `label` is optional to the reader,
so it reads an agent that writes none. Readers built before the
`acknowledgment` frame and the tool frame's `label` decoded every frame
type strictly and fail a turn that runs a tool against an agent that
writes them; nothing negotiates the protocol (the on-device bridge carries
no request headers), so this route and the reader that decodes it
(`client/stream-reader.vibe`), both in `@elizaos/agent`, ship in one
release. A voice client that speaks the reply from this stream speaks the
acknowledgment when it arrives; the agent's own voice session posts the
buffered send, which carries no acknowledgment.

## Story: See a reply as it is written

> As the owner, I want to watch my agent's reply appear as it is written
> and see what it is doing, and always end with the stored reply, so that
> a long answer never leaves me staring at nothing and a spoken reply
> never says words that are later taken back.

### Only a message that starts its own turn streams text, a repeat waits for its reply, and a refusal opens no stream

Turns' admission decides: `Owner` and `Unkeyed` stream the new turn and
first show `thinking`; `Duplicate` and `Settled` write nothing until the
reply of the turn they joined or replayed; `Conflict` (409), `Busy` (429)
and `InferenceUnavailable` (503) answer with that status before any frame,
so a refused message was not taken.

```quint
import turns as T from "./turns"
import binding as B from "../models/binding"
import streamUnits.* from "../../core/streamUnits"
type Role = Undecided | Streams | Waits | Refused
type Progress = NoProgress | Activity({ activity: str }) | ToolUse({ name: str, label: str })
type Acknowledgment = Unacknowledged | AckWaiting({ cue: List[int] }) | AckSent
type Readiness = NotReady | ReadyPending({ text: List[int], results: int }) | ReadySent({ results: int })
type Ending = Done({ reply: int, fullText: List[int], results: int, failure: str }) | Errored({ code: str })
type Frame = Token({ text: List[int], provisional: bool }) | TokenSnapshot({ text: List[int], fullText: List[int], provisional: bool })
  | Replace({ fullText: List[int], provisional: bool }) | AckFrame({ cue: List[int] }) | Progressed({ progress: Progress }) | ReadyFrame({ fullText: List[int], results: int }) | Final({ end: Ending })
type Phase = Open | Finishing({ end: Ending }) | Ended({ sent: Ending }) | Dropped
type Effect = Write({ frame: Frame }) | AbortTurn
type ReplyStream = { role: Role, phase: Phase, text: List[int], held: bool, shown: List[int], shownHeld: bool,
  sinceSnapshot: int, lastSnapshot: int, inFlight: bool, ack: Acknowledgment, progress: Progress, ready: Readiness }
type StreamStep = { state: ReplyStream, out: List[Effect] }
pure val initial: ReplyStream = { role: Undecided, phase: Open, text: List(), held: false, shown: List(), shownHeld: false,
  sinceSnapshot: 0, lastSnapshot: 0, inFlight: false, ack: Unacknowledged, progress: NoProgress, ready: NotReady }
pure def roleFor(verdict: T::Admission): Role = match verdict {
  | Owner(_) => Streams | Unkeyed(_) => Streams | Duplicate => Waits | Settled(_) => Waits | _ => Refused }
pure def canAdmit(s: ReplyStream): bool = s.role == Undecided
pure def admit(s: ReplyStream, verdict: T::Admission): StreamStep = {
  val role = roleFor(verdict)
  if (role == Streams) writeNext(false, { ...s, role: role, progress: Activity({ activity: "thinking" }) })
  else { state: { ...s, role: role }, out: List() }
}
pure val verdictValues = Set(T::Owner({ turn: 1 }), T::Unkeyed({ turn: 1 }), T::Duplicate, T::Settled({ reply: 3 }), T::Conflict, T::Busy, T::InferenceUnavailable)
pure def isOpen(p: Phase): bool = match p { | Open => true | _ => false }
pure def alwaysOnlyAStreamingTurnCarriesText(s: ReplyStream): bool =
  s.role != Streams implies (s.text == List() and not(s.held) and s.ack == Unacknowledged and s.progress == NoProgress and s.ready == NotReady and
    (isOpen(s.phase) implies (s.shown == List() and not(s.shownHeld) and not(s.inFlight))) and
    ((s.role == Undecided or s.role == Refused) implies (isOpen(s.phase) and s.sinceSnapshot == 0 and s.lastSnapshot == 0)))
pure def sometimesRefusedOpensNothing(s: ReplyStream): bool = s.role == Refused
```

### A frame is written only when the one before it has left, and nothing waits while the transport is free

The turn's acknowledgment, text, progress and early reply collect while a
frame is in flight; when it leaves, the next frame carries the
acknowledgment, then all text written since, then the early reply, then
the newest progress, which replaces an older one nobody saw. Text is never
dropped.

```quint
pure def textPending(s: ReplyStream): bool = s.text != s.shown or s.held != s.shownHeld
pure def readyPending(r: Readiness): bool = match r { | ReadyPending(_) => true | _ => false }
pure def readyFrame(r: Readiness): Frame = match r { | ReadyPending(x) => ReadyFrame({ fullText: x.text, results: x.results }) | _ => Progressed({ progress: NoProgress }) }
pure def readySent(r: Readiness): Readiness = match r { | ReadyPending(x) => ReadySent({ results: x.results }) | _ => r }
pure def ackWaiting(a: Acknowledgment): bool = match a { | AckWaiting(_) => true | _ => false }
pure def ackFrame(a: Acknowledgment): Frame = match a { | AckWaiting(x) => AckFrame({ cue: x.cue }) | _ => Progressed({ progress: NoProgress }) }
pure def threshold(previous: int): int = if (previous > 2048) previous else 2048
pure def appendable(s: ReplyStream): bool = unitPrefix(s.text, s.shown) and not(s.shownHeld and not(s.held))
pure def cadenceDue(s: ReplyStream): bool = s.sinceSnapshot + s.text.length() - s.shown.length() >= threshold(s.lastSnapshot)
pure def textFrame(s: ReplyStream): Frame = {
  val rest = sliceUnits(s.text, s.shown.length(), s.text.length())
  if (not(appendable(s))) Replace({ fullText: s.text, provisional: s.held })
  else if (cadenceDue(s)) TokenSnapshot({ text: rest, fullText: s.text, provisional: s.held })
  else Token({ text: rest, provisional: s.held })
}
pure def applyFrame(shown: List[int], f: Frame): List[int] = match f {
  | Token(x) => shown.concat(x.text) | TokenSnapshot(x) => x.fullText | Replace(x) => x.fullText
  | Final(x) => endText(x.end, shown) | _ => shown }
pure def endText(e: Ending, shown: List[int]): List[int] = match e { | Done(x) => x.fullText | Errored(_) => shown }
pure def ending(p: Phase): Ending = match p { | Finishing(x) => x.end | Ended(x) => x.sent | _ => Errored({ code: "" }) }
pure def isFinishing(p: Phase): bool = match p { | Finishing(_) => true | _ => false }
pure def isSent(p: Phase): bool = match p { | Ended(_) => true | _ => false }
pure def writeNext(left: bool, s: ReplyStream): StreamStep = {
  val t = { ...s, inFlight: s.inFlight and not(left) }
  val full = not(appendable(t)) or cadenceDue(t)
  val end = ending(t.phase)
  val endShown = endText(end, t.shown)
  if (t.inFlight) { state: t, out: List() }
  else if (isFinishing(t.phase)) { state: { ...t, phase: Ended({ sent: end }), inFlight: true, shown: endShown, shownHeld: false, sinceSnapshot: 0, lastSnapshot: endShown.length() },
    out: List(Write({ frame: Final({ end: end }) })) }
  else if (not(isOpen(t.phase))) { state: t, out: List() }
  else if (ackWaiting(t.ack)) { state: { ...t, inFlight: true, ack: AckSent }, out: List(Write({ frame: ackFrame(t.ack) })) }
  else if (textPending(t)) { state: { ...t, inFlight: true, shown: t.text, shownHeld: t.held,
      sinceSnapshot: if (full) 0 else t.sinceSnapshot + t.text.length() - t.shown.length(), lastSnapshot: if (full) t.text.length() else t.lastSnapshot },
    out: List(Write({ frame: textFrame(t) })) }
  else if (readyPending(t.ready)) { state: { ...t, inFlight: true, ready: readySent(t.ready) }, out: List(Write({ frame: readyFrame(t.ready) })) }
  else if (t.progress != NoProgress) { state: { ...t, inFlight: true, progress: NoProgress }, out: List(Write({ frame: Progressed({ progress: t.progress }) })) }
  else { state: t, out: List() }
}
pure def written(out: List[Effect]): List[Frame] = out.foldl(List(), (acc, e) => match e { | Write(w) => acc.append(w.frame) | AbortTurn => acc })
pure def canFrameFlushed(s: ReplyStream): bool = s.inFlight
pure def frameFlushed(s: ReplyStream): StreamStep = writeNext(true, s)
pure def alwaysCaughtUpWhenFree(s: ReplyStream): bool =
  (s.role == Streams and isOpen(s.phase) and not(s.inFlight)) implies
    (s.shown == s.text and s.shownHeld == s.held and not(ackWaiting(s.ack)) and s.progress == NoProgress and not(readyPending(s.ready)))
pure def stepOneFrameInFlight(before: ReplyStream, via: str, after: ReplyStream, out: List[Effect]): bool =
  written(out).length() <= 1 and
  (written(out).length() > 0 implies (after.inFlight and (not(before.inFlight) or via == "frameFlushed")))
pure def sometimesTextWaitsBehindAFrame(s: ReplyStream): bool = s.inFlight and s.text != s.shown and s.progress != NoProgress
```

### The frames written rebuild exactly the text the client holds

An append is written only when the client's text is a prefix of the
turn's; otherwise the frame carries the whole text.

```quint
pure def rebuilt(shown: List[int], out: List[Effect]): List[int] =
  written(out).foldl(shown, (acc, f) => applyFrame(acc, f))
pure def stepFramesRebuildTheText(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool = rebuilt(before.shown, out) == after.shown
```

### A frame marks its text provisional while any of it may be taken back, and only a whole text clears the mark

Resident chat sends model text, action callbacks and corrected previews as
provisional until the turn settles. A tool call or reply check can still
change the preview. A voice client never speaks provisional text, so an
append can only keep or add the mark: a client that ORs the mark over
appends and one that reads it per frame agree. The terminal reply carries
the settled text and clears the mark.

```quint
pure def canAppendText(s: ReplyStream, units: List[int]): bool = s.role == Streams and isOpen(s.phase) and units.length() > 0
pure def appendText(s: ReplyStream, units: List[int], provisional: bool): StreamStep =
  writeNext(false, { ...s, text: s.text.concat(units), held: s.held or provisional })
pure val unitsValues = {
  val u8 = List(97, 97, 97, 97, 97, 97, 97, 97)
  val u64 = u8.concat(u8).concat(u8).concat(u8).concat(u8).concat(u8).concat(u8).concat(u8)
  val u512 = u64.concat(u64).concat(u64).concat(u64).concat(u64).concat(u64).concat(u64).concat(u64)
  Set(List(), List(104), List(104, 105), u512.concat(u512).concat(u512).concat(u512))
}
pure def markOf(f: Frame): bool = match f { | Token(x) => x.provisional | TokenSnapshot(x) => x.provisional | Replace(x) => x.provisional | _ => false }
pure def stepAppendsNeverClearTheMark(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  written(out).every(f => match f { | Token(x) => x.provisional or not(before.shownHeld) | _ => true })
pure def isTextFrame(f: Frame): bool = match f { | Token(_) => true | TokenSnapshot(_) => true | Replace(_) => true | _ => false }
pure def stepMarkFollowsTheText(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  written(out).every(f => isTextFrame(f) implies markOf(f) == after.shownHeld)
pure def sometimesProvisionalShown(s: ReplyStream): bool = s.role == Streams and s.shownHeld and s.shown != List()
```

### A replacement never shortens the text to a prefix of itself unless the model restarted

A structured field may briefly normalise to a shorter prefix while it
streams; that is ignored. A new model attempt restarts the reply and
replaces even a prefix.

```quint
pure def canReplaceText(s: ReplyStream): bool = s.role == Streams and isOpen(s.phase)
pure def replaceText(s: ReplyStream, units: List[int], provisional: bool): StreamStep =
  if (unitPrefix(s.text, units) and units.length() < s.text.length()) { state: s, out: List() }
  else writeNext(false, { ...s, text: units, held: provisional })
pure def canRestartText(s: ReplyStream): bool = s.role == Streams and isOpen(s.phase)
pure def restartText(s: ReplyStream, units: List[int], provisional: bool): StreamStep =
  writeNext(false, { ...s, text: units, held: provisional })
pure def stepOnlyARestartShortensTheText(before: ReplyStream, via: str, after: ReplyStream): bool =
  (unitPrefix(before.text, after.text) and after.text.length() < before.text.length()) implies via == "restartText"
```

### Appended text carries the whole text again once the units appended since the last whole text reach the larger of 2048 and that text's length

A client that missed a frame recovers at the next whole text, and the
whole texts at least double in length, so the wire stays linear in the
reply.

```quint
pure def alwaysSnapshotCadence(s: ReplyStream): bool =
  s.sinceSnapshot >= 0 and s.lastSnapshot >= 0 and s.shown.length() == s.lastSnapshot + s.sinceSnapshot and s.sinceSnapshot < threshold(s.lastSnapshot)
pure def stepCadenceSnapshotsAtLeastDouble(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  written(out).every(f => match f { | TokenSnapshot(x) => x.fullText.length() >= 2 * before.lastSnapshot and x.fullText.length() >= before.lastSnapshot + 2048 | _ => true })
pure def sometimesTextAfterACadenceSnapshot(s: ReplyStream): bool = s.lastSnapshot >= 2048 and s.sinceSnapshot > 0
```

### Progress is display only, and only the newest waiting progress is written

```quint
pure def canShowProgress(s: ReplyStream, progress: Progress): bool = s.role == Streams and isOpen(s.phase) and progress != NoProgress
pure def showProgress(s: ReplyStream, progress: Progress): StreamStep = writeNext(false, { ...s, progress: progress })
pure val progressValues = Set(NoProgress, Activity({ activity: "thinking" }), Activity({ activity: "running_action" }), ToolUse({ name: "CALCULATE", label: "Working" }))
pure def stepProgressNeverTouchesTheText(before: ReplyStream, via: str, after: ReplyStream): bool =
  via == "showProgress" implies (after.text == before.text and after.held == before.held)
```

### The acknowledgment is written at most once, before the text and progress waiting with it, and only its own frame clears it

The turn hands the stream its acknowledgment once ([planning](./planning.md));
it never changes the text, and a tool or status that follows it fills the
progress slot, never the acknowledgment's, so the client sees both. An
acknowledgment still waiting when the terminal comes is not written.

```quint
pure def canAcknowledge(s: ReplyStream, units: List[int]): bool = s.role == Streams and isOpen(s.phase) and s.ack == Unacknowledged and units.length() > 0
pure def acknowledge(s: ReplyStream, units: List[int]): StreamStep = writeNext(false, { ...s, ack: AckWaiting({ cue: units }) })
pure def isAckFrame(f: Frame): bool = match f { | AckFrame(_) => true | _ => false }
pure def stepAcknowledgedAtMostOnce(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  (before.ack == AckSent implies (after.ack == AckSent and not(written(out).some(f => isAckFrame(f))))) and
  (written(out).some(f => isAckFrame(f)) implies (before.ack != AckSent and after.ack == AckSent))
pure def stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  (ackWaiting(before.ack) and not(ackWaiting(after.ack))) implies written(out).some(f => isAckFrame(f))
pure def stepAcknowledgingNeverTouchesTheText(before: ReplyStream, via: str, after: ReplyStream): bool =
  via == "acknowledge" implies (after.text == before.text and after.held == before.held and after.progress == before.progress)
pure def sometimesAcknowledgedThenTool(s: ReplyStream): bool = s.ack == AckSent and s.inFlight and s.progress != NoProgress
```

### The early reply is written at most once, and a stream that announced it ends with an answered done carrying the same action results

`reply_ready` lets a voice client speak a stored plain reply with no action
results while delivery cleanup settles. A reply whose write failed has no
announcement. Task presentations wait for the terminal because their
choices and revision are checked again after storage. An announcement
still waiting when the terminal comes is never written.

```quint
pure def announcedResults(r: Readiness): int = match r { | ReadyPending(x) => x.results | ReadySent(x) => x.results | NotReady => -1 }
pure def canAnnounceReply(s: ReplyStream): bool = s.role == Streams and isOpen(s.phase) and s.ready == NotReady
pure def announceReply(s: ReplyStream, units: List[int], results: int): StreamStep =
  writeNext(false, { ...s, ready: ReadyPending({ text: units, results: results }) })
pure val resultsValues = Set(0, 1)
pure def isReadyFrame(f: Frame): bool = match f { | ReadyFrame(_) => true | _ => false }
pure def isReadySent(r: Readiness): bool = match r { | ReadySent(_) => true | _ => false }
pure def stepReadyAtMostOnce(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  (isReadySent(before.ready) implies (after.ready == before.ready and not(written(out).some(f => isReadyFrame(f))))) and
  (written(out).some(f => isReadyFrame(f)) implies isReadySent(after.ready))
pure def doneAgrees(e: Ending, r: Readiness): bool = match e {
  | Done(x) => r == NotReady or (x.failure == "" and x.results == announcedResults(r)) | Errored(_) => true }
pure def alwaysAnAnnouncedReplyEndsAnswered(s: ReplyStream): bool =
  (isFinishing(s.phase) or isSent(s.phase)) implies doneAgrees(ending(s.phase), s.ready)
pure def sometimesReadyThenDone(s: ReplyStream): bool = s.ready != NotReady and not(readyPending(s.ready)) and isSent(s.phase)
```

### Every stream that is not dropped ends with exactly one done or error frame, after which nothing is written

A stored reply ends with `done`, its failure kind included (account
failure, `timeout` or `aborted`); a turn that left no reply ends with
`error` (`ASSISTANT_RESPONSE_UNAVAILABLE`, or a server failure). The
terminal replaces whatever text was still waiting, and the response ends
once it has left. The client returns the failure as soon as it reads a
complete `error` event, even if the transport has yet to close. After
`done` it still checks that no further events arrive before EOF.

```quint
pure def canFinish(s: ReplyStream, reply: int, kind: T::ReplyKind, results: int): bool =
  (s.role == Streams or s.role == Waits) and isOpen(s.phase) and reply >= 1 and
  (s.ready != NotReady implies (announcedResults(s.ready) == results and T::failureKind(kind) == ""))
pure def finish(s: ReplyStream, reply: int, units: List[int], kind: T::ReplyKind, results: int): StreamStep =
  writeNext(false, { ...s, progress: NoProgress, phase: Finishing({ end: Done({ reply: reply, fullText: units, results: results, failure: T::failureKind(kind) }) }) })
pure def canAnswerError(s: ReplyStream, code: str): bool = (s.role == Streams or s.role == Waits) and isOpen(s.phase) and code != ""
pure def answerError(s: ReplyStream, code: str): StreamStep =
  writeNext(false, { ...s, progress: NoProgress, phase: Finishing({ end: Errored({ code: code }) }) })
pure val replyValues = Set(3)
pure val kindValues = Set(T::Answered, T::TimedOut, T::Aborted)
pure val codeValues = Set("", "ASSISTANT_RESPONSE_UNAVAILABLE")
pure def isEnded(p: Phase): bool = match p { | Ended(_) => true | Dropped => true | _ => false }
pure def stepNothingAfterTheEnd(before: ReplyStream, after: ReplyStream, out: List[Effect]): bool =
  (isEnded(before.phase) implies (written(out) == List() and (after.phase == before.phase or after.phase == Dropped))) and
  written(out).every(f => match f { | Final(x) => not(isEnded(before.phase)) and isSent(after.phase) and ending(after.phase) == x.end | _ => true })
pure def failureOf(e: Ending): str = match e { | Done(x) => x.failure | Errored(_) => "" }
pure def sometimesFailedTurnStillDone(s: ReplyStream): bool = isSent(s.phase) and failureOf(ending(s.phase)) == "timeout"
pure def sometimesJoinedGetsTheReply(s: ReplyStream): bool = s.role == Waits and isSent(s.phase) and not(s.inFlight)
pure def sometimesErrorEnd(s: ReplyStream): bool = s.phase == Ended({ sent: Errored({ code: "ASSISTANT_RESPONSE_UNAVAILABLE" }) })
pure val fair_finish = "weak"
pure val fair_frameFlushed = "weak"
pure def leadsToAnEnd(s: ReplyStream, later: ReplyStream): bool =
  (s.role == Streams or s.role == Waits) implies isEnded(later.phase)
```

### A client that leaves aborts the turn it streams, and nothing more is written to it

The shell stops the turn through core's turn controllers; turns stores
what was written as an `aborted` reply. A request that only joined
another's turn leaves that turn running.

```quint
pure def canClientLeft(s: ReplyStream): bool =
  (s.role == Streams or s.role == Waits) and (isOpen(s.phase) or isFinishing(s.phase) or (isSent(s.phase) and s.inFlight))
pure def clientLeft(s: ReplyStream): StreamStep =
  { state: { ...s, phase: Dropped, inFlight: false }, out: if (s.role == Streams and isOpen(s.phase)) List(AbortTurn) else List() }
pure def stepLeavingAbortsOnlyAnOwnRunningTurn(before: ReplyStream, via: str, after: ReplyStream, out: List[Effect]): bool =
  out.some(e => e == AbortTurn) iff (via == "clientLeft" and before.role == Streams and isOpen(before.phase))
pure def sometimesDroppedMidTurn(s: ReplyStream): bool = s.phase == Dropped and s.role == Streams and s.text != List()
```
