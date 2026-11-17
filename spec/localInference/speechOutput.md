# Speech output

The device speaks the agent's replies through two parts that share no
state with one another, modeled side by side in one machine:

- **Publication.** A synthesized clip is prepared off the main thread and
  published on it into the one playback slot, which is empty, holds a
  prepared clip, or plays a stream.
- **Bootstrap.** Streamed speech starts with three requests to the same
  authorized origin (consent, session, then the socket upgrade), which
  reuse one connection whenever the protocol and the server allow it.

Priming the audio output before the first reply, and trimming each
utterance's silent lead, belong to the device's voice path:
[speech output](../os/voice/speechOutput.md). Device audio
hardware, the actual timings and network latency are outside this model.

## Story: Speak a reply without cutting off what is playing

> As a person talking to the agent on my device, I want a new reply to
> play only when nothing else is playing or when it is meant to replace
> what is, and never to hear a stale or cancelled reply.

### A prepared reply is published into the playback slot only if it may take it

The request is admitted with whether it replaces what is playing. At
publication, a cancelled request publishes nothing; a request that does
not replace finds the slot busy if anything is playing; otherwise the clip
takes the slot, interrupting what played before. A settled request makes
room for the next one.

```quint
type Playback = EmptyPlayback | PreparedClip | StreamPlayback
type PublishPhase = PublishIdle | PublishAdmitted | PublishBusy | Published | PublishCancelled
type Publication = { playback: Playback, publishPhase: PublishPhase, replace: bool, cancelRequested: bool, playbackAtPublication: Playback, interrupted: bool }
type Bootstrap = { started: bool, stage: int, http1: bool, keepAlive: bool, connections: int, pending: bool, stopped: bool }
type SpeechOutput = { publication: Publication, bootstrap: Bootstrap }
pure val initial: SpeechOutput = {
  publication: { playback: EmptyPlayback, publishPhase: PublishIdle, replace: false, cancelRequested: false, playbackAtPublication: EmptyPlayback, interrupted: false },
  bootstrap: { started: false, stage: 0, http1: false, keepAlive: false, connections: 0, pending: false, stopped: false }
}
pure def requestSettled(phase: PublishPhase): bool = phase == PublishIdle or phase == PublishBusy or phase == Published or phase == PublishCancelled
pure def canAdmitSpeech(s: SpeechOutput, replace: bool): bool = requestSettled(s.publication.publishPhase)
pure def admitSpeech(s: SpeechOutput, replace: bool): SpeechOutput =
  { ...s, publication: { ...s.publication, publishPhase: PublishAdmitted, replace: replace, cancelRequested: false, interrupted: false } }
pure def canChangePlayback(s: SpeechOutput, kind: Playback): bool = s.publication.publishPhase == PublishIdle or s.publication.publishPhase == PublishAdmitted
pure def changePlayback(s: SpeechOutput, kind: Playback): SpeechOutput = { ...s, publication: { ...s.publication, playback: kind } }
pure def canCancelSpeech(s: SpeechOutput): bool = s.publication.publishPhase == PublishAdmitted
pure def cancelSpeech(s: SpeechOutput): SpeechOutput = { ...s, publication: { ...s.publication, cancelRequested: true } }
pure def canPublishSpeech(s: SpeechOutput): bool = s.publication.publishPhase == PublishAdmitted
pure def publishSpeech(s: SpeechOutput): SpeechOutput = {
  val p = s.publication
  val resolved =
    if (p.cancelRequested) { ...p, publishPhase: PublishCancelled, playbackAtPublication: p.playback }
    else if (p.playback != EmptyPlayback and not(p.replace)) { ...p, publishPhase: PublishBusy, playbackAtPublication: p.playback }
    else { ...p, publishPhase: Published, playback: PreparedClip, playbackAtPublication: p.playback, interrupted: p.playback != EmptyPlayback }
  { ...s, publication: resolved }
}
```

### A busy or cancelled publication leaves what is playing untouched

```quint
pure def alwaysRefusedPublicationKeepsPlayback(s: SpeechOutput): bool =
  (s.publication.publishPhase == PublishBusy or s.publication.publishPhase == PublishCancelled) implies s.publication.playback == s.publication.playbackAtPublication
```

### Only a replacing, uncancelled reply interrupts what was playing

```quint
pure def alwaysInterruptsOnlyWithReplacement(s: SpeechOutput): bool =
  s.publication.interrupted implies (s.publication.publishPhase == Published and s.publication.replace and not(s.publication.cancelRequested))
```

### An admitted reply is settled

```quint
pure val fair_publishSpeech = "weak"
pure def leadsToPublicationSettles(s: SpeechOutput, later: SpeechOutput): bool =
  s.publication.publishPhase == PublishAdmitted implies later.publication.publishPhase != PublishAdmitted
```

### A reply can interrupt what plays, find the slot busy, or be cancelled while a stream plays

```quint
pure def sometimesReplacementInterrupts(s: SpeechOutput): bool = s.publication.interrupted
pure def sometimesBusyKeepsTheStream(s: SpeechOutput): bool = s.publication.publishPhase == PublishBusy and s.publication.playback == StreamPlayback
pure def sometimesCancelledKeepsTheStream(s: SpeechOutput): bool = s.publication.publishPhase == PublishCancelled and s.publication.playback == StreamPlayback
```

## Story: Start streamed speech without needless connections

> As a person starting a voice conversation, I want streamed speech to
> start quickly, over as few connections as the server allows.

### Bootstrap runs consent, session and socket in order, reusing the connection when it can

The first request opens a connection. A later request opens another only
when the server closes connections, and the socket upgrade opens another
when the bootstrap ran over HTTP/2, which cannot carry the upgrade. One
request is in flight at a time, and stopping settles the request in flight.

```quint
pure def canStartBootstrap(s: SpeechOutput, http1: bool, keepAlive: bool): bool = not(s.bootstrap.started)
pure def startBootstrap(s: SpeechOutput, http1: bool, keepAlive: bool): SpeechOutput =
  { ...s, bootstrap: { ...s.bootstrap, started: true, http1: http1, keepAlive: keepAlive } }
pure def canSendBootstrapRequest(s: SpeechOutput): bool =
  s.bootstrap.started and not(s.bootstrap.stopped) and s.bootstrap.stage < 3 and not(s.bootstrap.pending)
pure def sendBootstrapRequest(s: SpeechOutput): SpeechOutput = {
  val b = s.bootstrap
  val opens = b.stage == 0 or not(b.keepAlive) or (b.stage == 2 and not(b.http1))
  { ...s, bootstrap: { ...b, pending: true, connections: b.connections + (if (opens) 1 else 0) } }
}
pure def canCompleteBootstrapRequest(s: SpeechOutput): bool = s.bootstrap.pending and not(s.bootstrap.stopped)
pure def completeBootstrapRequest(s: SpeechOutput): SpeechOutput = { ...s, bootstrap: { ...s.bootstrap, stage: s.bootstrap.stage + 1, pending: false } }
pure def canStopBootstrap(s: SpeechOutput): bool = s.bootstrap.started and s.bootstrap.stage < 3 and not(s.bootstrap.stopped)
pure def stopBootstrap(s: SpeechOutput): SpeechOutput = { ...s, bootstrap: { ...s.bootstrap, pending: false, stopped: true } }
pure def alwaysBootstrapIsBounded(s: SpeechOutput): bool =
  s.bootstrap.stage >= 0 and s.bootstrap.stage <= 3 and s.bootstrap.connections >= 0 and s.bootstrap.connections <= 3 and (s.bootstrap.stopped implies not(s.bootstrap.pending))
```

### Each bootstrap request opens at most one connection

Before the bootstrap starts nothing connects, no request has completed
and none is in flight. A request opens at most one
connection, so a running bootstrap with no request in flight has no more
connections than completed requests, and at most one more while a request
is in flight or after a stop. Once a request was sent, a connection is open.

```quint
pure def alwaysEachRequestOpensAtMostOneConnection(s: SpeechOutput): bool =
  (not(s.bootstrap.started) implies s.bootstrap.connections == 0 and s.bootstrap.stage == 0 and not(s.bootstrap.pending)) and
  s.bootstrap.connections <= s.bootstrap.stage + 1 and
  ((not(s.bootstrap.stopped) and not(s.bootstrap.pending)) implies s.bootstrap.connections <= s.bootstrap.stage) and
  ((s.bootstrap.stage > 0 or s.bootstrap.pending) implies s.bootstrap.connections >= 1)
```

### A persistent HTTP/1.1 server needs one connection for the whole bootstrap

```quint
pure def alwaysReuseWhenCompatible(s: SpeechOutput): bool = (s.bootstrap.http1 and s.bootstrap.keepAlive) implies s.bootstrap.connections <= 1
```

### The socket opens only after consent and session

```quint
pure def alwaysSocketAfterBootstrap(s: SpeechOutput): bool = s.bootstrap.stage == 3 implies (s.bootstrap.connections >= 1 and not(s.bootstrap.pending))
```

### A started bootstrap connects or stops

```quint
pure val fair_sendBootstrapRequest = "weak"
pure val fair_completeBootstrapRequest = "weak"
pure def leadsToBootstrapSettles(s: SpeechOutput, later: SpeechOutput): bool =
  (s.bootstrap.started and s.bootstrap.stage < 3 and not(s.bootstrap.stopped)) implies (later.bootstrap.stage == 3 or later.bootstrap.stopped)
```

### A bootstrap can need one, two or three connections

```quint
pure def sometimesOneConnectionServesAll(s: SpeechOutput): bool = s.bootstrap.stage == 3 and s.bootstrap.http1 and s.bootstrap.keepAlive and s.bootstrap.connections == 1
pure def sometimesHttp2NeedsANewUpgrade(s: SpeechOutput): bool = s.bootstrap.stage == 3 and not(s.bootstrap.http1) and s.bootstrap.keepAlive and s.bootstrap.connections == 2
pure def sometimesClosingServerReconnects(s: SpeechOutput): bool = s.bootstrap.stage == 3 and not(s.bootstrap.keepAlive) and s.bootstrap.connections == 3
```
