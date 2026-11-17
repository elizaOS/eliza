# Transcript privacy

A transcript the device records (of a meeting, a call or a conversation)
keeps the consent state its capture recorded. Its owner and the agent's
admins may redact it or share it, and the original never changes:
redaction makes a linked variant with personal details removed, and
sharing writes a grant on the original that discloses either the full or
the redacted content to one person or to every participant of the meeting.
Only the original transcript is redacted or shared, never a variant.

This machine follows one transcript. Detecting personal details and
removing them from audio are done by services outside it; the model sees
whether any were found and whether the audio service verified its result.

## Story: Share a transcript only as its consent allows

> As someone recorded in a meeting, I want the transcript shared only when
> the recording's consent allows it, and with my personal details removed
> unless an admin decides otherwise.

### Capture consent is recorded once and never changes afterwards

```quint
type CaptureConsent = ConsentUnrecorded | ConsentGranted | ConsentNotRequired | ConsentDenied | ConsentUnknown
type ShareMode = FullShare | RedactedShare
type Requester = OwnerRequester | AdminRequester | OtherRequester
type RedactedVariant = NoVariant | TextVariant | AudioVariant
type TranscriptGrant = { grantee: str, mode: ShareMode, grantedByAdmin: bool }
type TranscriptPrivacy = { consent: CaptureConsent, originalRevision: int, hasAudio: bool, variant: RedactedVariant, grants: List[TranscriptGrant] }
pure val initial: TranscriptPrivacy = { consent: ConsentUnrecorded, originalRevision: 1, hasAudio: true, variant: NoVariant, grants: List() }
pure def canRecordConsent(s: TranscriptPrivacy, consent: CaptureConsent): bool = s.consent == ConsentUnrecorded and consent != ConsentUnrecorded
pure def recordConsent(s: TranscriptPrivacy, consent: CaptureConsent): TranscriptPrivacy = { ...s, consent: consent }
pure def stepConsentIsRecordedOnce(before: TranscriptPrivacy, after: TranscriptPrivacy): bool =
  before.consent != ConsentUnrecorded implies after.consent == before.consent
```

### Redaction makes a variant and never changes the original

Only the transcript's owner or an admin may redact it. When the
transcript has audio and personal details were found, the variant carries
audio only after the audio service verified the redacted audio; without
that service, redaction is refused rather than reusing the original
audio. When nothing was found, the variant withholds the audio.

```quint
pure def mayRedact(requester: Requester): bool = requester == OwnerRequester or requester == AdminRequester
pure def redactedVariantFor(s: TranscriptPrivacy, detailsFound: bool): RedactedVariant =
  if (s.hasAudio and detailsFound) AudioVariant else TextVariant
pure def audioRedactionAvailable(s: TranscriptPrivacy, detailsFound: bool, audioVerified: bool): bool =
  redactedVariantFor(s, detailsFound) != AudioVariant or audioVerified
pure def canRedactTranscript(s: TranscriptPrivacy, requester: Requester, detailsFound: bool, audioVerified: bool): bool =
  mayRedact(requester) and audioRedactionAvailable(s, detailsFound, audioVerified)
pure def redactTranscript(s: TranscriptPrivacy, requester: Requester, detailsFound: bool, audioVerified: bool): TranscriptPrivacy =
  { ...s, variant: redactedVariantFor(s, detailsFound) }
pure def stepOriginalNeverChanges(before: TranscriptPrivacy, after: TranscriptPrivacy): bool =
  after.originalRevision == before.originalRevision and after.hasAudio == before.hasAudio
```

### A transcript is shared only when its capture consent was granted or not required

An unrecorded, unknown or denied consent refuses every share.

```quint
pure def consentAllowsSharing(consent: CaptureConsent): bool = consent == ConsentGranted or consent == ConsentNotRequired
pure def alwaysGrantsFollowConsent(s: TranscriptPrivacy): bool = s.grants.length() == 0 or consentAllowsSharing(s.consent)
```

### The full transcript is shared only by an admin; the redacted one by its owner or an admin

Sharing the redacted transcript refreshes its variant first, under the
same audio rule as redaction. Each grant names one person.

```quint
pure val granteeValues = Set("participant1", "participant2")
pure def mayShareWith(requester: Requester, mode: ShareMode): bool =
  if (mode == FullShare) requester == AdminRequester else mayRedact(requester)
pure def canShareTranscript(s: TranscriptPrivacy, requester: Requester, grantee: str, mode: ShareMode, detailsFound: bool, audioVerified: bool): bool =
  consentAllowsSharing(s.consent) and mayShareWith(requester, mode) and (mode == FullShare or audioRedactionAvailable(s, detailsFound, audioVerified))
pure def shareTranscript(s: TranscriptPrivacy, requester: Requester, grantee: str, mode: ShareMode, detailsFound: bool, audioVerified: bool): TranscriptPrivacy =
  { ...s, variant: if (mode == RedactedShare) redactedVariantFor(s, detailsFound) else s.variant,
    grants: s.grants.append({ grantee: grantee, mode: mode, grantedByAdmin: requester == AdminRequester }) }
pure def alwaysFullGrantsComeFromAnAdmin(s: TranscriptPrivacy): bool = s.grants.every(g => g.mode == FullShare implies g.grantedByAdmin)
pure def alwaysRedactedGrantsHaveAVariant(s: TranscriptPrivacy): bool = s.grants.every(g => g.mode == RedactedShare implies s.variant != NoVariant)
```

### Only an admin shares with the whole meeting, and only the redacted transcript

The meeting's participants are the roster recorded with the transcript.

```quint
pure val meetingRoster = List("participant1", "participant2")
pure def canRedactForAll(s: TranscriptPrivacy, requester: Requester, detailsFound: bool, audioVerified: bool): bool =
  consentAllowsSharing(s.consent) and requester == AdminRequester and audioRedactionAvailable(s, detailsFound, audioVerified)
pure def redactForAll(s: TranscriptPrivacy, requester: Requester, detailsFound: bool, audioVerified: bool): TranscriptPrivacy =
  { ...s, variant: redactedVariantFor(s, detailsFound),
    grants: s.grants.concat(meetingRoster.listMap(p => { grantee: p, mode: RedactedShare, grantedByAdmin: true })) }
```

### A transcript can be shared in full, shared redacted with its audio, and refused for lack of consent

```quint
pure def sometimesSharedInFull(s: TranscriptPrivacy): bool = s.grants.some(g => g.mode == FullShare)
pure def sometimesSharedWithRedactedAudio(s: TranscriptPrivacy): bool = s.variant == AudioVariant and s.grants.some(g => g.mode == RedactedShare)
pure def sometimesConsentDeniedKeepsItPrivate(s: TranscriptPrivacy): bool = s.consent == ConsentDenied and s.variant != NoVariant and s.grants.length() == 0
```
