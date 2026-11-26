# On-device inference host

The agent runs in a Node child that cannot load the device's native
inference library, so the app process serves the
[local inference](../../localInference/index.md) engine for it. The host
listens on an abstract local socket the consumer names, takes one
length-prefixed UTF-8 JSON frame per request and answers one frame, and
keeps one resident native context for speech and the end-of-turn score
and one session for embeddings. The consumer supplies the native library
behind the host, under its own identity, and the model storage directory
the host confines every path to. The resident's engine reaches the host
through `@elizaos/os`. Text is never generated on the device
([model binding](../../agent/models/binding.md)): the host offers no
generation operation.

## Story: Embed, speak and transcribe on my phone through my app alone

> As the owner, I want my agent to embed my notes, speak its replies and
> transcribe what I say on the phone itself, through my app's own native
> engine, so that none of it leaves the device and no other app can use it.

### Only the app's own process is served, for an operation the host offers, within its frame limit and its model storage

A connection whose peer is not the app's own Android user is closed
before a frame is read. A frame is at most 16 MiB, the limit of a
transcription's audio, and any other operation's frame is at most 1 MiB;
an oversized frame is answered `FRAME_TOO_LARGE` with its limit, and a
frame over 16 MiB also ends the connection, since its body is unread. An
operation the host does not offer, text generation among them, is
`OP_REFUSED`. A model path a request names must resolve, links followed,
inside the consumer's model storage, or the request is `PATH_REFUSED`.

```quint
type HostOp = OpCapabilities | OpLoad | OpUnload | OpWarmEmbedding | OpEmbed | OpSynthesize | OpTranscribe | OpCancelSpeech | OpEndOfTurn | OpNotOffered
type RequestVerdict = RequestServed | PeerRefused | FrameTooLarge | OpRefused | PathRefused
pure val textFrameBytes = 1048576
pure val audioFrameBytes = 16777216
pure def frameLimit(op: HostOp): int = if (op == OpTranscribe) audioFrameBytes else textFrameBytes
pure def requestVerdict(sameUid: bool, op: HostOp, bytes: int, pathsConfined: bool): RequestVerdict =
  if (not(sameUid)) PeerRefused
  else if (bytes > frameLimit(op)) FrameTooLarge
  else if (op == OpNotOffered) OpRefused
  else if (not(pathsConfined)) PathRefused
  else RequestServed
pure val bytesValues = Set(0, 1048576, 1048577, 16777216, 16777217)
pure def lawOnlyTheAppsOwnProcessIsServed(op: HostOp, bytes: int, pathsConfined: bool): bool =
  requestVerdict(false, op, bytes, pathsConfined) == PeerRefused
pure def lawNoOperationBeyondTheOfferedOnes(bytes: int, pathsConfined: bool): bool =
  requestVerdict(true, OpNotOffered, bytes, pathsConfined) != RequestServed
pure def lawAServedRequestFitsItsFrameAndStorage(sameUid: bool, op: HostOp, bytes: int, pathsConfined: bool): bool =
  requestVerdict(sameUid, op, bytes, pathsConfined) == RequestServed implies (bytes <= frameLimit(op) and pathsConfined)
```

### One pass runs at a time on its own context, nothing is freed under it, and a failed pass drops the context it used

Synthesis and transcription run on the resident context, opened on the
consumer's speech bundle when no model is loaded, and the end-of-turn
score needs a loaded model. Embeddings run on their own session, opened
when it is warmed or first used. A pass holds its own context until it
ends, so a speech or end-of-turn pass and an embedding pass may run at
once, while loading, unloading and the idle or memory-pressure release
free each context only after the pass on it. A caller hanging up cancels
only its own speech pass. A queued speech request whose disconnect is
observed before admission never starts. An explicit cancel request can
target the active synthesis or transcription. A cancelled pass ends as
`CANCELLED`. A pass the native library rejected for its input leaves its
context; any other failure drops that context alone, so the next pass on
it opens it again.

```quint
type PassKind = NoPass | SpeechPass | EmbeddingPass | EndOfTurnPass
type InferenceHost = { resident: bool, embedding: bool, residentPass: PassKind, embeddingPass: bool, cancelAsked: bool }
pure val initial: InferenceHost = { resident: false, embedding: false, residentPass: NoPass, embeddingPass: false, cancelAsked: false }
pure def canLoad(s: InferenceHost): bool = s.residentPass == NoPass
pure def load(s: InferenceHost): InferenceHost = { ...s, resident: true }
pure def canReleaseResident(s: InferenceHost): bool = s.residentPass == NoPass
pure def releaseResident(s: InferenceHost): InferenceHost = { ...s, resident: false }
pure def canReleaseEmbedding(s: InferenceHost): bool = not(s.embeddingPass)
pure def releaseEmbedding(s: InferenceHost): InferenceHost = { ...s, embedding: false }
pure def canWarmEmbedding(s: InferenceHost, verified: bool): bool = not(s.embeddingPass) and verified
pure def warmEmbedding(s: InferenceHost, verified: bool): InferenceHost = { ...s, embedding: true }
pure def canStartPass(s: InferenceHost, kind: PassKind): bool =
  if (kind == EmbeddingPass) not(s.embeddingPass)
  else kind != NoPass and s.residentPass == NoPass and (kind == EndOfTurnPass implies s.resident)
pure def startPass(s: InferenceHost, kind: PassKind): InferenceHost =
  if (kind == EmbeddingPass) { ...s, embeddingPass: true, embedding: true }
  else { ...s, residentPass: kind, resident: s.resident or kind == SpeechPass }
pure def canAskCancel(s: InferenceHost): bool = s.residentPass == SpeechPass and not(s.cancelAsked)
pure def cancelsSpeechPass(s: InferenceHost, callerOwnsPass: bool, explicit: bool): bool =
  canAskCancel(s) and (callerOwnsPass or explicit)
pure def lawAnotherCallerHangingUpCannotCancel(s: InferenceHost): bool = not(cancelsSpeechPass(s, false, false))
pure def askCancel(s: InferenceHost): InferenceHost = { ...s, cancelAsked: true }
pure def passRuns(s: InferenceHost, kind: PassKind): bool =
  if (kind == EmbeddingPass) s.embeddingPass else kind != NoPass and s.residentPass == kind
pure def canFinishPass(s: InferenceHost, kind: PassKind): bool = passRuns(s, kind)
pure def finishPass(s: InferenceHost, kind: PassKind): InferenceHost =
  if (kind == EmbeddingPass) { ...s, embeddingPass: false } else { ...s, residentPass: NoPass, cancelAsked: false }
pure def canFailPass(s: InferenceHost, kind: PassKind): bool = passRuns(s, kind)
pure def failPass(s: InferenceHost, kind: PassKind): InferenceHost =
  if (kind == EmbeddingPass) { ...s, embeddingPass: false, embedding: false }
  else { ...s, residentPass: NoPass, cancelAsked: false, resident: false }
pure def alwaysAPassHasItsContext(s: InferenceHost): bool =
  (s.residentPass != NoPass implies s.resident) and (s.embeddingPass implies s.embedding)
pure def alwaysTheResidentRunsNoEmbedding(s: InferenceHost): bool = s.residentPass != EmbeddingPass
pure def alwaysACancelIsForARunningSpeechPass(s: InferenceHost): bool = s.cancelAsked implies s.residentPass == SpeechPass
pure def stepNothingIsFreedDuringAPass(before: InferenceHost, after: InferenceHost): bool =
  ((before.residentPass != NoPass and after.residentPass != NoPass) implies after.resident == before.resident)
    and ((before.embeddingPass and after.embeddingPass) implies after.embedding == before.embedding)
pure def stepAFailedPassDropsTheContextItUsed(before: InferenceHost, via: str, after: InferenceHost): bool =
  via == "failPass" implies (
    (before.embeddingPass and not(after.embeddingPass) and not(after.embedding)
      and after.residentPass == before.residentPass and after.resident == before.resident)
    or (before.residentPass != NoPass and after.residentPass == NoPass and not(after.resident)
      and after.embeddingPass == before.embeddingPass and after.embedding == before.embedding))
pure def sometimesASpeechPassIsCancelled(s: InferenceHost): bool = s.cancelAsked
pure def sometimesAnEmbeddingRunsBesideASpeechPass(s: InferenceHost): bool = s.embeddingPass and s.residentPass == SpeechPass
```

### An embedding is answered only by the verified model assigned to embeddings, as a finite vector of its dimensions

The request names the assigned model's file, its pinned SHA-256 and its
vector space. The host opens the session only on a file whose digest is
that one, and answers only a vector of exactly the space's dimensions,
every component finite and the whole not zero, scaled to unit length. A
model without a pinned digest is not embedded on the device; any other
vector is `FAILED`, never a vector from another model.

```quint
type EmbeddingVerdict = VectorServed | ArtifactRefused | VectorRefused
pure def embeddingVerdict(digestMatches: bool, dimensions: int, returned: int, finite: bool, nonZero: bool): EmbeddingVerdict =
  if (not(digestMatches)) ArtifactRefused
  else if (returned != dimensions or not(finite) or not(nonZero)) VectorRefused
  else VectorServed
pure val dimensionsValues = Set(384, 768)
pure val returnedValues = Set(0, 383, 384, 768)
pure def lawAServedVectorIsTheVerifiedModelsOwn(digestMatches: bool, dimensions: int, returned: int, finite: bool, nonZero: bool): bool =
  embeddingVerdict(digestMatches, dimensions, returned, finite, nonZero) == VectorServed
    iff (digestMatches and returned == dimensions and finite and nonZero)
```

### Speech readiness and the end-of-turn score say only what the host answered

Speech is ready for synthesis or transcription only as the host reports
it; a host that is absent or does not answer reports neither. The
end-of-turn score is the native probability, in thousandths, that the
transcript ends a turn; the turn is complete at 500 or more. Without a
loaded model, or a library that cannot score, the score is unavailable
with the reason.

```quint
type SpeechReadiness = { synthesis: bool, transcription: bool }
pure def speechReadiness(answered: bool, synthesis: bool, transcription: bool): SpeechReadiness =
  { synthesis: answered and synthesis, transcription: answered and transcription }
pure val endOfTurnCommitMilli = 500
pure def endOfTurnComplete(milli: int): bool = milli >= endOfTurnCommitMilli
pure def endOfTurnMilliAdmitted(milli: int): bool = milli >= 0 and milli <= 1000
pure val milliValues = Set(-1, 0, 499, 500, 1000, 1001)
pure def lawAnUnansweredHostIsReadyForNothing(synthesis: bool, transcription: bool): bool =
  speechReadiness(false, synthesis, transcription) == { synthesis: false, transcription: false }
pure def lawCompletenessFollowsTheScore(milli: int): bool =
  endOfTurnComplete(milli) iff milli >= endOfTurnCommitMilli
```
