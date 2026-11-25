# Visual voicemail

What the phone app reads from and changes in Android's voicemail provider:
the carrier state, a page of voicemail rows, a request for a voicemail's
audio, its speech-ready PCM, the owner's "heard", and the owner's delete,
which waits in the [deletion journal](./deferredDeletion.md) so that it can
be undone. The sources are `VoicemailStore.java` and `VoicemailPcm.java` of
the native messages plugin.
Each operation passes the device check of [the bridge](./bridge.md); the
capability names it serves, `voicemail.read.v1` (list, audio, PCM, heard) and
`voicemail.delete.v1` (delete), are the agent's
(`spec/agent/deviceActions/capabilities.md`) and are not restated here.
Transcribing the PCM is not this spec's. Provider queries, the change
observer, broadcasts and decoding stay in the Java shell.

## Story: See my voicemail only when my carrier offers it

> As an owner, I want my voicemail list to show what Android's voicemail
> provider holds, and a carrier without visual voicemail never shown as
> "no voicemail".

### Every voicemail operation needs telephony and the voicemail grant at the time of the call

Holding the default dialer role counts as the grant. The bridge checks the
evidence on each call, never once per install.

```quint
import bridge.* from "./bridge"
pure val voicemailCall: BridgeCall = { need: Anytime, needsGrant: true, needsFeature: true }
pure def deviceAllows(facts: HostFacts): bool = admitCall(PluginRegistered, voicemailCall, facts) == CallAdmitted
pure def lawVoicemailNeedsTelephonyAndGrant(facts: HostFacts): bool = deviceAllows(facts) iff (facts.featurePresent and facts.granted)
```

### The carrier is ready only when a source is configured, and unsupported when every source is disabled or none exists

The shell reads the sources' status rows for the default calling account;
a row without a configuration state is read as pending, never as configured.

```quint
type SourceConfiguration = SourceConfigured | SourcePending | SourceDisabled
type CarrierState = CarrierUnread | CarrierReady | CarrierUnconfigured | CarrierUnsupported
pure def carrierOf(sources: List[SourceConfiguration]): CarrierState =
  if (sources.includes(SourceConfigured)) CarrierReady else if (sources.includes(SourcePending)) CarrierUnconfigured else CarrierUnsupported
pure val sourcesValues = Set(List(), List(SourceConfigured), List(SourceDisabled), List(SourcePending, SourceDisabled), List(SourceDisabled, SourceConfigured))
pure def lawCarrierFollowsItsSources(sources: List[SourceConfiguration]): bool =
  (carrierOf(sources) == CarrierReady iff sources.includes(SourceConfigured)) and (carrierOf(sources) == CarrierUnsupported iff sources.every(c => c == SourceDisabled))
```

### A refresh shows exactly the provider's rows, keyed by provider ID, and none for an unsupported carrier

A refresh is one successful read of the provider: the carrier state, then,
unless it is unsupported, at most one page of the newest rows that are not
deleted. A row deleted elsewhere is gone from the next refresh. A listing
with an unusable or repeated ID fails the read and changes nothing. The
provider observer only asks for a refresh; such an automatic refresh cannot
release a write gate ([the last story](#story-change-a-voicemail-only-as-the-provider-confirms-it)).

```quint
type AudioCustody = AudioNotAsked | AudioAsked | AudioOnPhone
type VoicemailRow = { id: int, heard: bool, audio: AudioCustody }
type ListedRow = { id: int, heard: bool, hasAudio: bool }
type Voicemail = { carrier: CarrierState, rows: List[VoicemailRow], gate: WriteGate }
pure val initial: Voicemail = { carrier: CarrierUnread, rows: List(), gate: WriteIdle }
pure val maxVoicemails = 50
pure def hasRow(rows: List[VoicemailRow], id: int): bool = rows.some(r => r.id == id)
pure def rowAt(rows: List[VoicemailRow], id: int): VoicemailRow = rows.select(r => r.id == id).nthOr(0, { id: id, heard: false, audio: AudioNotAsked })
pure def wellKeyed(listed: List[ListedRow]): bool = listed.length() <= maxVoicemails and listed.every(r => r.id > 0 and listed.select(q => q.id == r.id).length() == 1)
pure def audioAfterListing(rows: List[VoicemailRow], r: ListedRow): AudioCustody =
  if (r.hasAudio) AudioOnPhone else if (rowAt(rows, r.id).audio != AudioNotAsked) AudioAsked else AudioNotAsked
pure def listingRows(rows: List[VoicemailRow], listed: List[ListedRow]): List[VoicemailRow] = listed.listMap(r => { id: r.id, heard: r.heard, audio: audioAfterListing(rows, r) })
pure def canRefresh(s: Voicemail, facts: HostFacts, read: ReadEvidence, sources: List[SourceConfiguration], listed: List[ListedRow]): bool = deviceAllows(facts) and read.succeeded and wellKeyed(listed)
pure def refresh(s: Voicemail, facts: HostFacts, read: ReadEvidence, sources: List[SourceConfiguration], listed: List[ListedRow]): Voicemail = {
  val carrier = carrierOf(sources)
  { carrier: carrier, rows: if (carrier == CarrierUnsupported) List() else listingRows(s.rows, listed), gate: gateOnRead(s.gate, read) }
}
pure val listedValues = Set(List(), List({ id: 1, heard: false, hasAudio: false }), List({ id: 1, heard: false, hasAudio: true }, { id: 2, heard: true, hasAudio: false }),
  List({ id: 2, heard: false, hasAudio: true }), List({ id: 2, heard: false, hasAudio: false }, { id: 2, heard: true, hasAudio: false }))
pure val rowsValues = Set(List(), List({ id: 1, heard: false, audio: AudioAsked }), List({ id: 2, heard: true, audio: AudioOnPhone }, { id: 3, heard: false, audio: AudioNotAsked }))
pure def lawRefreshShowsExactlyTheListing(rows: List[VoicemailRow], read: ReadEvidence, sources: List[SourceConfiguration], listed: List[ListedRow]): bool = {
  val after = refresh({ carrier: CarrierReady, rows: rows, gate: WriteIdle }, { foreground: true, unlocked: true, focused: true, granted: true, featurePresent: true }, read, sources, listed)
  after.rows.listMap(r => r.id) == (if (carrierOf(sources) == CarrierUnsupported) List() else listed.listMap(r => r.id)) and
  after.rows.every(r => listed.includes({ id: r.id, heard: r.heard, hasAudio: r.audio == AudioOnPhone }))
}
pure def alwaysRowsKeyedByProviderId(s: Voicemail): bool = s.rows.length() <= maxVoicemails and s.rows.every(r => r.id > 0 and s.rows.select(q => q.id == r.id).length() == 1)
pure def alwaysNoRowsWithoutACarrierThatHasThem(s: Voicemail): bool = (s.carrier == CarrierUnread or s.carrier == CarrierUnsupported) implies s.rows.length() == 0
pure def sometimesUnsupportedCarrierRead(s: Voicemail): bool = s.carrier == CarrierUnsupported
pure def sometimesUnconfiguredCarrierListsRows(s: Voicemail): bool = s.carrier == CarrierUnconfigured and s.rows.length() > 0
```

### A retired observer admits no refresh and a replacement waits for acknowledged cleanup

One phone client holds one observation. Closing it stops accepting its
callbacks before awaiting the listener's removal and Android's disable.
A replacement waits until both steps are acknowledged. A rejected cleanup
leaves that step outstanding for the next visit. A late close of the
retired observation cannot disable its replacement.

## Story: Hear a voicemail

> As an owner, I want to play a voicemail and have it ready for speech
> recognition, whole or not at all.

### A voicemail's audio is asked of its source at most once

A row whose audio is not on the phone asks its own source to download it;
the answer proves only that the request was sent. A row that names no
source, or whose request could not be sent, stays unasked. A row once
asked, or once holding audio, is never asked again; the next refresh shows
the audio.

```quint
type PcmRefusal = PcmTooLong | PcmUndecodable
type FetchSend = SentToSource | NoSourceToAsk
type VoicemailReply = FetchRequested({ id: int }) | FetchFailed({ id: int }) | Wrote({ id: int, written: WriteOutcome }) | PcmReturned({ id: int, samples: int }) | PcmRefused({ id: int, reason: PcmRefusal })
type VoicemailStep = { state: Voicemail, out: List[VoicemailReply] }
pure val idValues = Set(1, 2, 3)
pure def canRequestAudio(s: Voicemail, facts: HostFacts, id: int): bool = deviceAllows(facts) and hasRow(s.rows, id) and rowAt(s.rows, id).audio == AudioNotAsked
pure def requestAudio(s: Voicemail, facts: HostFacts, id: int, sent: FetchSend): VoicemailStep =
  if (sent == NoSourceToAsk) { state: s, out: List(FetchFailed({ id: id })) }
  else { state: { ...s, rows: s.rows.listMap(r => if (r.id == id) { ...r, audio: AudioAsked } else r) }, out: List(FetchRequested({ id: id })) }
pure def stepAskedAudioIsNeverForgotten(before: Voicemail, after: Voicemail): bool =
  after.rows.every(r => (hasRow(before.rows, r.id) and rowAt(before.rows, r.id).audio != AudioNotAsked) implies r.audio != AudioNotAsked)
pure def stepFetchOnlyForAnUnaskedRow(before: Voicemail, via: str, after: Voicemail, out: List[VoicemailReply]): bool =
  out.every(o => match o { | FetchRequested(f) => hasRow(before.rows, f.id) and rowAt(before.rows, f.id).audio == AudioNotAsked and rowAt(after.rows, f.id).audio == AudioAsked | _ => true })
pure def sometimesAudioAsked(s: Voicemail): bool = s.rows.some(r => r.audio == AudioAsked)
pure def sometimesAudioOnPhone(s: Voicemail): bool = s.rows.some(r => r.audio == AudioOnPhone)
```

### Speech-ready PCM is returned whole within five minutes of 16 kHz mono, or refused

The shell decodes the stored audio to 16 kHz mono 16-bit PCM in a WAV
container. Audio one sample past five minutes is refused whole, never
clipped; audio the phone cannot decode, or that decodes to nothing, is
refused. Every returned WAV fits in 10 MiB.

```quint
type PcmDecode = DecodedSamples({ samples: int }) | Undecodable
pure val maxPcmSamples = 16000 * 300
pure val maxWavBytes = 10 * 1024 * 1024
pure def pcmReply(id: int, decode: PcmDecode): VoicemailReply = match decode {
  | DecodedSamples(d) => if (d.samples > maxPcmSamples) PcmRefused({ id: id, reason: PcmTooLong }) else if (d.samples < 1) PcmRefused({ id: id, reason: PcmUndecodable }) else PcmReturned({ id: id, samples: d.samples })
  | Undecodable => PcmRefused({ id: id, reason: PcmUndecodable })
}
pure def canDecodePcm(s: Voicemail, facts: HostFacts, id: int, decode: PcmDecode): bool = deviceAllows(facts) and hasRow(s.rows, id) and rowAt(s.rows, id).audio == AudioOnPhone
pure def decodePcm(s: Voicemail, facts: HostFacts, id: int, decode: PcmDecode): VoicemailStep = { state: s, out: List(pcmReply(id, decode)) }
pure val decodeValues = Set(Undecodable, DecodedSamples({ samples: 0 }), DecodedSamples({ samples: 16000 }), DecodedSamples({ samples: 4800000 }), DecodedSamples({ samples: 4800001 }))
pure def lawReturnedPcmIsWholeAndFitsItsWav(id: int, decode: PcmDecode): bool = match decode {
  | DecodedSamples(d) => (pcmReply(id, decode) == PcmReturned({ id: id, samples: d.samples })) iff (d.samples >= 1 and d.samples <= maxPcmSamples and 44 + 2 * d.samples <= maxWavBytes)
  | Undecodable => pcmReply(id, decode) == PcmRefused({ id: id, reason: PcmUndecodable })
}
```

## Story: Change a voicemail only as the provider confirms it

> As an owner, I want "heard" to change my list only when the provider
> committed the change and read it back, and a delete to wait ten seconds
> for Undo and remove the voicemail only as the provider confirms, so that a
> voicemail is never shown as deleted while it is still there.

### Heard changes the list only when the provider applied it, and only a refresh removes a row

The shell turns the provider's answer into a bridge `ProviderReply`. A
voicemail from this app's own carrier client is marked heard and asked to
sync. A row leaves the list only when a refresh no longer lists it.

```quint
pure def canWriteRow(s: Voicemail, facts: HostFacts, id: int, reply: ProviderReply): bool =
  deviceAllows(facts) and gateAllowsWrite(s.gate) and hasRow(s.rows, id)
pure def writeRow(s: Voicemail, facts: HostFacts, id: int, reply: ProviderReply): VoicemailStep = {
  val written = writeOutcome(reply)
  val rows = if (written != Applied) s.rows else s.rows.listMap(r => if (r.id == id) { ...r, heard: true } else r)
  { state: { ...s, rows: rows, gate: gateOnOutcome(gateOnDispatch(s.gate), written) }, out: List(Wrote({ id: id, written: written })) }
}
pure def stepLocalChangesNeedAnAppliedWrite(before: Voicemail, via: str, after: Voicemail, out: List[VoicemailReply]): bool =
  via != "refresh" implies (
    after.rows.every(r => (r.heard and not(rowAt(before.rows, r.id).heard)) implies out.includes(Wrote({ id: r.id, written: Applied }))) and
    before.rows.every(r => hasRow(after.rows, r.id)))
pure def sometimesHeardRowRemains(s: Voicemail): bool = s.rows.some(r => r.heard)
```

### A delete waits in the deletion window, and its row is hidden only while it is queued

The owner's confirmed delete is staged as a voicemail record exactly where a
write could start: the voicemail grant on the phone with telephony, a listed
row and an idle gate. Staging writes nothing to the provider and leaves the
gate and the rows as they are; the list leaves out each row whose deletion
is queued. At expiry the journal's provider call deletes the row as Android
allows its source: a voicemail from this app's own carrier client is marked
deleted and asked to sync, which removes it from the carrier and then from
the phone; another source's row is deleted through the provider, which
keeps it deleted for that source. Only a row Android no longer lists is
deleted; a marked row still listed is uncertain.

```quint
pure def canStageDelete(s: Voicemail, facts: HostFacts, id: int): bool = canWriteRow(s, facts, id, NoReply)
pure def stageDelete(s: Voicemail, facts: HostFacts, id: int): Voicemail = s
pure def shownRows(rows: List[VoicemailRow], queued: List[int]): List[VoicemailRow] = rows.select(r => not(queued.includes(r.id)))
pure val queuedValues = Set(List(), List(1), List(2, 3))
pure def lawAQueuedDeleteHidesOnlyItsRow(rows: List[VoicemailRow], queued: List[int]): bool =
  shownRows(rows, queued).every(r => rows.includes(r) and not(queued.includes(r.id))) and
  rows.every(r => queued.includes(r.id) or shownRows(rows, queued).includes(r))
pure def stepStagingADeleteChangesNothing(before: Voicemail, via: str, after: Voicemail): bool = via == "stageDelete" implies after == before
```

### An uncertain write blocks the next write until an explicit refresh that began after it

A lost or unconfirmed reply leaves the gate unsettled; nothing retries the
write, and only an explicit read that began after it settled reopens it.

```quint
pure def sometimesWriteUnsettled(s: Voicemail): bool = s.gate == WriteUnsettled and s.rows.length() > 0
pure def stepOnlyARefreshReopensTheGate(before: Voicemail, via: str, after: Voicemail): bool =
  (before.gate == WriteUnsettled and after.gate != WriteUnsettled) implies (via == "refresh" and after.gate == WriteIdle)
```
