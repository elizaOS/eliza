# Media store and redaction

The agent stores uploaded and generated media content-addressed, through its
media routes and effect adapters (audio redaction, generation and connector
delivery). [Core media](../core/media.md) owns the media records. This spec
owns one stored object: its streamed publication under its content hash, and
one redaction run on it through the effect pipeline. Hashing, bytes, MIME
parsing and the provider's algorithm enter as checked inputs.

## Story: Store my media only once its content is verified, and redact it without pretending

> As a user, media I upload or generate is published only when its content
> matches its address. A redaction is checked before it runs, and if it fails,
> is cancelled or ends uncertain, I am told so instead of being shown a
> success.

### A stream is published under its content address only after the hash verifies

A stream opens pending and takes chunks. Finishing seals it if the computed
hash equals the address it will be published under; otherwise publication
fails. Only a sealed, complete and synced stream is published, and an aborted
or failed stream is never public.

```quint
type MediaPhase = MediaAbsent | MediaPending | MediaSealed | MediaPublished | MediaFailed
type RedactionPhase = RedactionNone | RedactionNew | RedactionValidated | RedactionRunning | RedactionPersisting | RedactionComplete | RedactionFailed | RedactionCancelled | RedactionUncertain
type MediaObject = { phase: MediaPhase, chunks: int, complete: bool, synced: bool, hashVerified: bool, published: bool, redaction: RedactionPhase, validated: bool, dispatched: bool, cancelled: bool, verifiedVariant: bool, variant: bool }
pure val initial: MediaObject = { phase: MediaAbsent, chunks: 0, complete: false, synced: false, hashVerified: false, published: false, redaction: RedactionNone, validated: false, dispatched: false, cancelled: false, verifiedVariant: false, variant: false }
pure def canOpenStream(m: MediaObject): bool = m.phase == MediaAbsent
pure def openStream(m: MediaObject): MediaObject = { ...m, phase: MediaPending }
pure def canAppendChunk(m: MediaObject): bool = m.phase == MediaPending
pure def appendChunk(m: MediaObject): MediaObject = { ...m, chunks: m.chunks + 1 }
pure def canFinishStream(m: MediaObject, hashMatches: bool): bool = m.phase == MediaPending and m.chunks > 0
pure def finishStream(m: MediaObject, hashMatches: bool): MediaObject =
  if (hashMatches) { ...m, phase: MediaSealed, complete: true, synced: true, hashVerified: true } else { ...m, phase: MediaFailed, chunks: 0 }
pure def canPublish(m: MediaObject): bool = m.phase == MediaSealed and m.complete and m.synced and m.hashVerified
pure def publish(m: MediaObject): MediaObject = { ...m, phase: MediaPublished, published: true }
pure def canAbortStream(m: MediaObject): bool = m.phase == MediaPending or m.phase == MediaSealed
pure def abortStream(m: MediaObject): MediaObject = { ...m, phase: MediaFailed, chunks: 0 }
pure def alwaysPublishedContentIsVerified(m: MediaObject): bool = m.published implies (m.complete and m.synced and m.hashVerified)
pure def alwaysFailedStreamIsNotPublic(m: MediaObject): bool = m.phase == MediaFailed implies not(m.published)
pure def sometimesPartialStreamAborted(m: MediaObject): bool = m.phase == MediaFailed and not(m.hashVerified)
```

### A redaction is validated before it is dispatched

A redaction of published media starts new and is validated first; invalid
input fails it without dispatching anything. Only a validated, uncancelled
redaction is dispatched to its provider.

```quint
pure def canRequestRedaction(m: MediaObject): bool = m.published and m.redaction == RedactionNone
pure def requestRedaction(m: MediaObject): MediaObject = { ...m, redaction: RedactionNew }
pure def canValidateRedaction(m: MediaObject, valid: bool): bool = m.redaction == RedactionNew
pure def validateRedaction(m: MediaObject, valid: bool): MediaObject =
  if (valid) { ...m, redaction: RedactionValidated, validated: true } else { ...m, redaction: RedactionFailed }
pure def canDispatchRedaction(m: MediaObject): bool = m.redaction == RedactionValidated and not(m.cancelled)
pure def dispatchRedaction(m: MediaObject): MediaObject = { ...m, redaction: RedactionRunning, dispatched: true }
pure def alwaysDispatchFollowsValidation(m: MediaObject): bool = m.dispatched implies m.validated
```

### A redacted variant is saved only after its result is verified, and every other ending is distinct

The provider's response is verified before the variant is persisted; only a
persisted variant completes the redaction. A failure or cancellation before
dispatch is a failure or a cancellation; after dispatch it is uncertain,
because the provider may have acted. None of these is a success.

```quint
pure def canReceiveRedaction(m: MediaObject, verified: bool): bool = m.redaction == RedactionRunning and not(m.cancelled)
pure def receiveRedaction(m: MediaObject, verified: bool): MediaObject =
  if (verified) { ...m, redaction: RedactionPersisting, verifiedVariant: true } else { ...m, redaction: RedactionUncertain }
pure def canPersistVariant(m: MediaObject): bool = m.redaction == RedactionPersisting and m.verifiedVariant and not(m.cancelled)
pure def persistVariant(m: MediaObject): MediaObject = { ...m, redaction: RedactionComplete, variant: true }
pure def openRedaction(phase: RedactionPhase): bool = phase == RedactionValidated or phase == RedactionRunning or phase == RedactionPersisting
pure def canFailRedaction(m: MediaObject): bool = openRedaction(m.redaction)
pure def failRedaction(m: MediaObject): MediaObject = { ...m, redaction: if (m.dispatched) RedactionUncertain else RedactionFailed }
pure def canCancelRedaction(m: MediaObject): bool = m.redaction == RedactionNew or openRedaction(m.redaction)
pure def cancelRedaction(m: MediaObject): MediaObject = { ...m, redaction: if (m.dispatched) RedactionUncertain else RedactionCancelled, cancelled: true }
pure def alwaysVariantNeedsVerifiedRedaction(m: MediaObject): bool = m.variant implies (m.verifiedVariant and m.published and m.dispatched and not(m.cancelled))
pure def alwaysCompleteRedactionHasItsVariant(m: MediaObject): bool = m.redaction == RedactionComplete implies m.variant
pure def stepCancelledAfterDispatchIsUncertain(before: MediaObject, via: str, after: MediaObject): bool =
  (via == "cancelRedaction" and before.dispatched) implies after.redaction == RedactionUncertain
pure def sometimesVariantPersisted(m: MediaObject): bool = m.variant
pure def sometimesCancelledAfterDispatch(m: MediaObject): bool = m.redaction == RedactionUncertain and m.cancelled
pure def sometimesCancelledBeforeDispatch(m: MediaObject): bool = m.redaction == RedactionCancelled
```
