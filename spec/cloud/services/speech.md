# Batch speech

The cloud turns a reply into audio (`POST /api/v1/voice/tts`) and a recording
into text (`POST /api/v1/voice/stt`) for a signed-in device. One provider of
each direction serves a deployment, named with its voices, models, languages
and prices by the deployment's speech profile, with no fallback. Each request
runs over one hold of [metering](../shared/metering.md), whose caller is the
organization, and is settled once. The [device side](../../os/voice/cloudSpeech.md)
uses these routes and [the realtime speech relay](./speechRelay.md). The
batch routes and provider integration live in
`packages/cloud-worker/src/services/speech.vibe` and
`packages/cloud-worker/src/providers/speech.vibe`.

The shell handles a request in this order: for transcription the declared
body cap, then `requestAuth` on a key-or-session route (`speechEntry`), the deployment's
capability gate, the plan's standard request limit (`speechLimit`), the body
(`ttsCheck` or `sttCheck`), the quote, `M::admission` on a fresh hold, the
standing check and `M::markDispatched` that metering requires, the provider,
and one `settlementOf`. A synthesis sent with an `Idempotency-Key` is held
under that key and what it speaks, so a retry of it is never paid twice; a
transcription's request id is minted per request. Wire names (`withTimestamps`, `duration_ms`, the 0.7 to 1.2 decimal speed)
and the client wire codecs are in `packages/cloud/src/services/speech-batch.schema.ts`.

## Story: Speak a reply as audio

> As the owner of an on-device agent, I want a reply spoken in the voice and
> pace I chose, with its timing when I ask for it, and paid for only when the
> provider could have produced it, so that my agent can talk without
> surprising me on my bill.

### A synthesis names 1 to 5,000 characters, at most 5,000 of context on each side, a pace from 0.7 to 1.2, a voice and model the profile offers, and MP3 when it asks for timing

`previousText` and `nextText` guide the provider's prosody and are never
spoken. An absent voice or model is the profile's default; a model is
offered when it has exactly one price row of 1 to 10,000 µUSD per character.
Context, a pace, a normalization (`auto`, `on`, `off`) or timing is refused
`400 invalid_request` with reason `unsupported_field` when the profile's
provider does not render options; any other fault is `400 invalid_request`.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
import rateLimit as R from "../shared/rateLimit"
import requestAuth as RA from "../identity/requestAuth"
import plans as P from "../billing/plans"
type TtsFormat = Mp3 | Wav
type Normalization = DefaultNormalization | AutoNormalization | ForcedNormalization | NoNormalization
type Pace = DefaultPace | PaceHundredths({ hundredths: int })
type Pick = ProfileDefault | Named({ id: str })
type ModelPrice = { modelId: str, perCharacter: Micros }
type SpeechProfile = { ttsProvider: str, voices: List[str], defaultVoice: str, models: List[ModelPrice], defaultModel: str, rendersOptions: bool, sttProvider: str, languages: List[str], sttPerSecond: Micros }
type TtsRequest = { textChars: CharCount, previousChars: CharCount, nextChars: CharCount, voice: Pick, model: Pick, format: TtsFormat, pace: Pace, normalization: Normalization, timestamps: bool }
type Synthesis = { voiceId: str, modelId: str, perCharacter: Micros, textChars: CharCount, timed: bool, servedPace: Pace }
type TtsCheck = SynthesisAccepted({ synthesis: Synthesis }) | SynthesisRefused({ refusal: Refusal })
pure val maxTextChars: CharCount = 5000
pure val minPace: int = 70
pure val maxPace: int = 120
pure val maxPerCharacter: Micros = 10000
pure val noPrice: ModelPrice = { modelId: "", perCharacter: 0 }
pure def paceFits(p: Pace): bool = match p { | DefaultPace => true | PaceHundredths(x) => x.hundredths >= minPace and x.hundredths <= maxPace }
pure def chosen(p: Pick, fallback: str): str = match p { | ProfileDefault => fallback | Named(x) => x.id }
pure def charsFit(chars: CharCount, fewest: int): bool = chars >= fewest and chars <= maxTextChars
pure def asksOptions(r: TtsRequest): bool =
  r.previousChars > 0 or r.nextChars > 0 or r.pace != DefaultPace or r.normalization != DefaultNormalization or r.timestamps
pure def ttsCheck(profile: SpeechProfile, r: TtsRequest): TtsCheck = {
  val voiceId = chosen(r.voice, profile.defaultVoice)
  val modelId = chosen(r.model, profile.defaultModel)
  val rows = profile.models.select(m => m.modelId == modelId)
  val row = rows.nthOr(0, noPrice)
  if (not(charsFit(r.textChars, 1) and charsFit(r.previousChars, 0) and charsFit(r.nextChars, 0) and paceFits(r.pace)) or (r.timestamps and r.format == Wav)
      or not(profile.voices.includes(voiceId)) or rows.length() != 1 or row.perCharacter < 1 or row.perCharacter > maxPerCharacter)
    SynthesisRefused({ refusal: refuse(InvalidRequest) })
  else if (asksOptions(r) and not(profile.rendersOptions)) SynthesisRefused({ refusal: refuseFor(InvalidRequest, UnsupportedField) })
  else SynthesisAccepted({ synthesis: { voiceId: voiceId, modelId: modelId, perCharacter: row.perCharacter, textChars: r.textChars, timed: r.timestamps, servedPace: r.pace } })
}
pure val plain: SpeechProfile = { ttsProvider: "p1", voices: List("v1"), defaultVoice: "v1", models: List({ modelId: "m1", perCharacter: 50 }), defaultModel: "m1", rendersOptions: false, sttProvider: "s1", languages: List("en"), sttPerSecond: 3 }
pure val profileValues: Set[SpeechProfile] = Set(plain, { ...plain, rendersOptions: true, voices: List("v1", "v2"), models: List({ modelId: "m1", perCharacter: 50 }, { modelId: "m2", perCharacter: 100 }) },
  { ...plain, models: List({ modelId: "m1", perCharacter: 50 }, { modelId: "m1", perCharacter: 100 }) })
pure val spoken: TtsRequest = { textChars: 12, previousChars: 0, nextChars: 0, voice: ProfileDefault, model: ProfileDefault, format: Mp3, pace: DefaultPace, normalization: DefaultNormalization, timestamps: false }
pure val rValues: Set[TtsRequest] = Set(spoken, { ...spoken, textChars: 0 }, { ...spoken, textChars: 5000, voice: Named({ id: "v2" }), model: Named({ id: "m2" }) },
  { ...spoken, previousChars: 40, pace: PaceHundredths({ hundredths: 120 }), timestamps: true }, { ...spoken, timestamps: true, format: Wav },
  { ...spoken, pace: PaceHundredths({ hundredths: 69 }) }, { ...spoken, model: Named({ id: "m3" }) })
pure def lawAnAcceptedSynthesisFitsTheProfile(profile: SpeechProfile, r: TtsRequest): bool = {
  val c = ttsCheck(profile, r)
  match c {
    | SynthesisAccepted(x) => profile.voices.includes(x.synthesis.voiceId) and x.synthesis.perCharacter >= 1 and x.synthesis.perCharacter <= maxPerCharacter
        and charsFit(r.textChars, 1) and paceFits(r.pace) and not(r.timestamps and r.format == Wav) and (asksOptions(r) implies profile.rendersOptions)
    | SynthesisRefused(x) => wellFormed(x.refusal) and statusOf(x.refusal.code) == 400
  }
}
```

### A synthesis is quoted at its characters times the model's price plus 20 percent, rounded half up, and its context is never charged

```quint
pure val markupPercent: int = 120
pure def withMarkup(base: int): Micros = (base * markupPercent + 50) / 100
pure def ttsQuote(s: Synthesis): Micros = withMarkup(s.textChars * s.perCharacter)
pure def requestQuote(profile: SpeechProfile, r: TtsRequest): Micros = {
  val c = ttsCheck(profile, r)
  match c { | SynthesisAccepted(x) => ttsQuote(x.synthesis) | SynthesisRefused(x) => 0 }
}
pure def isAccepted(c: TtsCheck): bool = match c { | SynthesisAccepted(x) => true | SynthesisRefused(x) => false }
pure val contextCharsValues = Set(0, 1, 5000)
pure def lawContextIsNeverCharged(profile: SpeechProfile, r: TtsRequest, contextChars: CharCount): bool = {
  val guided = { ...r, previousChars: contextChars, nextChars: contextChars }
  (isAccepted(ttsCheck(profile, r)) and isAccepted(ttsCheck(profile, guided))) implies requestQuote(profile, guided) == requestQuote(profile, r)
}
pure def lawEveryAcceptedSynthesisHoldsMoney(profile: SpeechProfile, r: TtsRequest): bool =
  isAccepted(ttsCheck(profile, r)) implies requestQuote(profile, r) >= 1
```

### A synthesis answers with the provider's id, with the pace served exactly when a pace was asked, and with the timing mark exactly when timing was asked

The headers are `X-Eliza-TTS-Provider`, `X-Eliza-TTS-Speed` and
`X-Eliza-TTS-Timing: character-v1`; untimed audio is `audio/mpeg` or
`audio/wav`, timed audio `application/x-ndjson`.

```quint
type TtsHeaders = { providerId: str, paceHeader: Pace, timingHeader: bool }
pure def ttsHeaders(profile: SpeechProfile, s: Synthesis): TtsHeaders = { providerId: profile.ttsProvider, paceHeader: s.servedPace, timingHeader: s.timed }
pure def lawTheAnswerNamesWhatWasServed(profile: SpeechProfile, r: TtsRequest): bool = {
  val c = ttsCheck(profile, r)
  match c {
    | SynthesisAccepted(x) => ttsHeaders(profile, x.synthesis) == { providerId: profile.ttsProvider, paceHeader: r.pace, timingHeader: r.timestamps }
    | SynthesisRefused(x) => true
  }
}
```

### A timed answer carries at most 2,048 audio frames numbered from 0 and 8 MiB of audio, and ends with one done line only after some audio

The service validates and assembles the NDJSON before answering. Each audio
line is `{type: "audio", sequence, audioBase64, alignment}`, followed by
`{type: "done"}`. A provider frame that would pass a cap, an empty frame, or
an end with no audio refuses the answer as `502 provider_invalid_response`
and settles the hold as an unclear reply.

```quint
type TimedStream = { frames: int, audioBytes: int }
type TimedStep = NextFrame({ sequence: int, stream: TimedStream }) | StreamBroken
pure val maxTimedFrames: int = 2048
pure val maxTimedAudioBytes: int = 8 * 1024 * 1024
pure def addFrame(sent: TimedStream, bytes: int): TimedStep =
  if (bytes < 1 or sent.frames >= maxTimedFrames or sent.audioBytes + bytes > maxTimedAudioBytes) StreamBroken
  else NextFrame({ sequence: sent.frames, stream: { frames: sent.frames + 1, audioBytes: sent.audioBytes + bytes } })
pure def mayEnd(sent: TimedStream): bool = sent.frames >= 1 and sent.audioBytes >= 1
pure val sentValues: Set[TimedStream] = Set({ frames: 0, audioBytes: 0 }, { frames: 2047, audioBytes: 8388000 }, { frames: 2048, audioBytes: 9000 })
pure val bytesValues = Set(0, 1, 608, 1000)
pure def withinCaps(sent: TimedStream): bool = sent.frames >= 0 and sent.frames <= maxTimedFrames and sent.audioBytes >= sent.frames and sent.audioBytes <= maxTimedAudioBytes
pure def lawFramesStayNumberedAndWithinCaps(sent: TimedStream, bytes: int): bool = {
  val following = addFrame(sent, bytes)
  withinCaps(sent) implies match following { | NextFrame(x) => x.sequence == sent.frames and withinCaps(x.stream) and mayEnd(x.stream) | StreamBroken => true }
}
```

## Story: Transcribe a recording

> As the owner of an on-device agent, I want a recording I made turned into
> text by the deployment's provider and charged for its length, so that I can
> dictate without running a recognizer on my device.

The provider request and response decoding share a 120-second budget.
Cloud parses the upload and prepares the multipart request body before
that budget starts.

### A transcription with a declared body over 25 MiB is refused 413 before its credential is read

On an offered route, a declared length over the cap is refused before
credential lookup. The multipart reader also enforces the limit after
authentication, including when the caller omitted the length. For every
synthesis, the credential is checked as `requestAuth` checks a key-or-session
route, and its refusal is the answer.

```quint
type BatchSpeech = TtsRoute | SttRoute
type SpeechEntry = RecordingTooLarge | Authenticated({ admission: RA::Admission })
pure val maxSttBodyBytes: int = 25 * 1024 * 1024
pure val tooLargeRefusal: Refusal = refuse(ContentTooLarge)
pure def speechEntry(route: BatchSpeech, declaredBodyBytes: int, presented: RA::Presented, standing: RA::Standing, now: Millis): SpeechEntry =
  if (route == SttRoute and declaredBodyBytes > maxSttBodyBytes) RecordingTooLarge
  else Authenticated({ admission: RA::admit(RA::KeyOrSessionRoute, presented, standing, now) })
pure val declaredBodyBytesValues = Set(0, 26214400, 26214401)
pure def lawAPredeclaredOversizeRecordingIsRefusedWhoeverSendsIt(declaredBodyBytes: int, presented: RA::Presented, standing: RA::Standing, now: Millis): bool =
  declaredBodyBytes > maxSttBodyBytes implies (speechEntry(SttRoute, declaredBodyBytes, presented, standing, now) == RecordingTooLarge and wellFormed(tooLargeRefusal) and statusOf(tooLargeRefusal.code) == 413)
```

### A transcription needs one audio part of an accepted type whose bytes match it, and names only a language the profile lists and only the deployment's provider

The accepted types are `audio/mpeg`, `audio/mp3`, `audio/mp4`, `audio/m4a`,
`audio/x-m4a`, `audio/wav`, `audio/x-wav`, `audio/webm` and `audio/ogg`; the
shell checks the leading bytes against the type. It parses a positive
duration from WAV files and estimates it from size and type for other
formats. An invalid part is refused `400 invalid_request`. The answer is
`{transcript, duration_ms, segments?, words?}` with `X-Eliza-STT-Provider`.

```quint
type AudioPart = NoAudio | AudioFile({ mime: str, bytesMatch: bool })
type SttForm = { audio: AudioPart, language: Pick, provider: Pick, durationMs: Millis }
type SttCheck = TranscriptionAccepted({ providerId: str, durationMs: Millis }) | TranscriptionRefused({ refusal: Refusal })
pure val audioTypes: Set[str] = Set("audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg")
pure def audioFits(a: AudioPart): bool = match a { | AudioFile(x) => audioTypes.contains(x.mime) and x.bytesMatch | NoAudio => false }
pure def languageFits(profile: SpeechProfile, p: Pick): bool = match p { | ProfileDefault => true | Named(x) => profile.languages.includes(x.id) }
pure def providerFits(profile: SpeechProfile, p: Pick): bool = match p { | ProfileDefault => true | Named(x) => x.id == profile.sttProvider }
pure def sttCheck(profile: SpeechProfile, form: SttForm): SttCheck =
  if (audioFits(form.audio) and languageFits(profile, form.language) and providerFits(profile, form.provider) and form.durationMs > 0 and profile.sttPerSecond >= 1)
    TranscriptionAccepted({ providerId: profile.sttProvider, durationMs: form.durationMs })
  else TranscriptionRefused({ refusal: refuse(InvalidRequest) })
pure val heard: SttForm = { audio: AudioFile({ mime: "audio/wav", bytesMatch: true }), language: ProfileDefault, provider: Named({ id: "s1" }), durationMs: 4200 }
pure val formValues: Set[SttForm] = Set(heard, { ...heard, audio: NoAudio }, { ...heard, audio: AudioFile({ mime: "video/mp4", bytesMatch: true }) },
  { ...heard, audio: AudioFile({ mime: "audio/wav", bytesMatch: false }) }, { ...heard, provider: Named({ id: "s2" }) }, { ...heard, language: Named({ id: "en" }) }, { ...heard, language: Named({ id: "xx" }) })
pure def lawATranscriptionRunsOnlyOnTheDeploymentsProvider(profile: SpeechProfile, form: SttForm): bool = {
  val c = sttCheck(profile, form)
  match c {
    | TranscriptionAccepted(x) => x.providerId == profile.sttProvider and providerFits(profile, form.provider) and audioFits(form.audio) and languageFits(profile, form.language)
    | TranscriptionRefused(x) => wellFormed(x.refusal) and statusOf(x.refusal.code) == 400
  }
}
```

### A transcription is quoted at its whole seconds, at least one, times the per-second price plus 20 percent, and a longer recording never costs less

The quote uses the upload duration. A successful transcription reports a
positive duration, which determines settlement. A missing or unreadable
duration makes the provider answer unclear and settles the quote.

```quint
pure def billedSeconds(durationMs: Millis): int = if (durationMs <= millisPerSecond) 1 else (durationMs + millisPerSecond - 1) / millisPerSecond
pure def sttCost(profile: SpeechProfile, durationMs: Millis): Micros = withMarkup(billedSeconds(durationMs) * profile.sttPerSecond)
type ReportedDuration = DurationReported({ ms: Millis }) | NoDuration
pure def sttMeasured(profile: SpeechProfile, reported: ReportedDuration, quote: Micros): Micros =
  match reported { | DurationReported(x) => sttCost(profile, x.ms) | NoDuration => quote }
pure val shorterValues = Set(0, 1000, 1001, 60000)
pure val longerValues = Set(0, 1001, 2000, 60001)
pure def lawALongerRecordingNeverCostsLess(profile: SpeechProfile, shorter: Millis, longer: Millis): bool =
  (0 <= shorter and shorter <= longer and profile.sttPerSecond >= 1) implies (sttCost(profile, shorter) >= 1 and sttCost(profile, shorter) <= sttCost(profile, longer))
```

## Story: Pay once for each batch speech request

> As an account owner, I want each spoken reply and each transcription
> charged once, nothing when it never reached the provider or the provider
> refused it, so that a failed request costs me nothing it did not use.

### Each batch request holds once under its organization and its request id, and spends one request of the plan's standard limit

A transcription's request id is minted per request, so a resent recording
is a new paid request and an `Idempotency-Key` sent with it is ignored. A
synthesis sent without an `Idempotency-Key` is minted an id the same way.
One sent with a key of 1 to 128 of `A-Z`, `a-z`, `0-9`, `_` and `-` is held
under that key joined with a digest of what it speaks, each part as
resolved from the profile: its text, context, voice, model, format, pace,
normalization and timing. Any other key is refused `400 invalid_request`.
The same key with other words, another voice or other options is a new paid
request. A synthesis whose hold already exists, a retry after a lost
answer, is spoken again and moves no money: the first request's settlement
stands. It is spoken again only while that hold is dispatched or has been
charged; one released, or settled at nothing because the provider refused
it, is refused `409 idempotency_conflict` with no provider call, since
nothing paid for it.

```quint
pure def speechHoldKey(organization: str, requestId: str): HoldKey = { service: MeteredSpeech, caller: organization, requestId: requestId, part: WholeRequest }
pure def speechLimit(plan: P::PlanKey): R::RateLimit = R::perMinute(P::planRateLimitName(P::StandardRequests), P::requestsPerMinute(plan, P::StandardRequests))
pure def lawSpeechSharesTheStandardLimitAndNoHold(plan: P::PlanKey, organization: str, other: str, requestId: str): bool =
  R::validLimit(speechLimit(plan)) and speechLimit(plan).name == P::planRateLimitName(P::StandardRequests)
    and (speechHoldKey(organization, requestId) == speechHoldKey(other, requestId) implies organization == other)
type SynthesisCourse = SpeakFresh | SpeakAgain | RefuseSpeechRepeat
pure def synthesisCourseOf(replayed: bool, earlier: M::Hold): SynthesisCourse =
  if (not(replayed)) SpeakFresh
  else if (earlier.phase == M::Dispatched or (earlier.phase == M::Settled and earlier.charged + earlier.uncollected > 0)) SpeakAgain
  else RefuseSpeechRepeat
pure val earlierValues: Set[M::Hold] = Set(M::initial, { ...M::initial, phase: M::Reserved, quote: 9, reserved: 9 }, { ...M::initial, phase: M::Dispatched, quote: 9, reserved: 9 },
  { ...M::initial, phase: M::Settled, quote: 9, reserved: 9, charged: 9 }, { ...M::initial, phase: M::Settled, quote: 9, reserved: 9 }, { ...M::initial, phase: M::Released, quote: 9, reserved: 9 })
pure def lawOnlyAFreshSynthesisHolds(replayed: bool, earlier: M::Hold): bool =
  (synthesisCourseOf(replayed, earlier) == SpeakFresh iff not(replayed))
    and (synthesisCourseOf(replayed, earlier) == SpeakAgain implies (earlier.phase == M::Dispatched or earlier.phase == M::Settled))
    and (earlier.phase == M::Released implies synthesisCourseOf(replayed, earlier) != SpeakAgain)
```

### A dispatched request is charged nothing when the provider refused it, what it measured when it answered, and its quote when the reply was unclear; one never dispatched is charged nothing

A provider status 200 to 299 is an answer, 400 to 499 a refusal that
produced nothing; any other status, a timeout, a network failure, a broken
timed stream or an unreadable transcription is unclear. A synthesis
measures its quote; a transcription measures `sttMeasured`.

```quint
type ProviderReply = ProviderAnswered | ProviderRefused | ProviderUnclear
type SpeechSettlement = ChargeMeasured({ actual: Micros }) | ChargeQuote | ReleaseUncharged
pure def replyOf(status: int): ProviderReply =
  if (status >= 200 and status <= 299) ProviderAnswered else if (status >= 400 and status <= 499) ProviderRefused else ProviderUnclear
pure def settlementOf(dispatched: bool, reply: ProviderReply, measured: Micros): SpeechSettlement =
  if (not(dispatched)) ReleaseUncharged
  else if (reply == ProviderRefused) ChargeMeasured({ actual: 0 })
  else if (reply == ProviderAnswered) ChargeMeasured({ actual: measured })
  else ChargeQuote
pure def applySettlement(h: M::Hold, settlement: SpeechSettlement, creditFree: Micros): M::Hold = match settlement {
  | ChargeMeasured(c) => M::settleKnown(h, c.actual, creditFree)
  | ChargeQuote => M::settleUnknown(h)
  | ReleaseUncharged => M::release(h)
}
pure val replyValues = Set(ProviderAnswered, ProviderRefused, ProviderUnclear)
pure val measuredValues = Set(0, 2, 9)
pure def heldFor(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): M::Hold =
  M::reserve(M::initial, speechHoldKey("o1", "r1"), quote, lane, allowanceAvailable, creditAvailable, 0)
pure def lawADispatchedRequestIsChargedOnceForWhatItUsed(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, reply: ProviderReply, measured: Micros, creditFree: Micros): bool = {
  val closed = applySettlement(M::markDispatched(heldFor(lane, quote, allowanceAvailable, creditAvailable), 0), settlementOf(true, reply, measured), creditFree)
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and measured >= 0 and creditFree >= 0) implies
    (closed.phase == M::Settled and (reply == ProviderRefused implies closed.charged == 0)
      and (reply == ProviderUnclear implies closed.charged == quote) and (reply == ProviderAnswered implies closed.charged + closed.uncollected == measured))
}
pure def lawAnUndispatchedRequestIsChargedNothing(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, reply: ProviderReply, measured: Micros, creditFree: Micros): bool = {
  val ended = applySettlement(heldFor(lane, quote, allowanceAvailable, creditAvailable), settlementOf(false, reply, measured), creditFree)
  M::fundable(lane, quote, allowanceAvailable, creditAvailable) implies (ended.phase == M::Released and ended.charged == 0)
}
```

### A provider outage is retryable, and every batch speech refusal is well formed

A timeout, network failure, provider `429` or provider `5xx` answers
`503 provider_unavailable` with `Retry-After`. For `429` and `5xx`, the
service uses a provider retry hint when present. Otherwise it waits one
second. Other provider status refusals and unreadable audio or transcription
answers produce `502 provider_invalid_response`. The refusals of
`requestAuth`, the rate limiter and metering pass through unchanged.

```quint
pure val providerRetryMs: Millis = millisPerSecond
pure def providerOutage(now: Millis): Refusal = refuseUntil(ProviderUnavailable, now + providerRetryMs)
pure val unreadableSpeech: Refusal = refuse(ProviderInvalidResponse)
pure def providerStatusRefusal(status: int, hint: Millis, now: Millis): Refusal =
  if (status == 429 or status >= 500)
    if (hint >= 0) refuseUntil(ProviderUnavailable, now + hint) else providerOutage(now)
  else unreadableSpeech
pure val statusValues = Set(302, 400, 429, 500)
pure val hintValues = Set(-1, 0, 5000)
pure def lawProviderFailuresAreWellFormed(now: Millis): bool =
  wellFormed(providerOutage(now)) and retryableOf(providerOutage(now)) and wellFormed(unreadableSpeech) and not(retryableOf(unreadableSpeech))
    and retryAfterSeconds(now + providerRetryMs, now) == 1
pure def lawOnlyRateLimitsAndServerStatusRefusalsAreRetryable(status: int, hint: Millis, now: Millis): bool =
  retryableOf(providerStatusRefusal(status, hint, now)) iff (status == 429 or status >= 500)
```
