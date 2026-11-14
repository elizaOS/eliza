# Voice transcript and typed draft ownership

Grace `48b43b9c` calls `DraftTranscriptGuard` from
`apps/app/src/VoiceControls.tsx`. The producer is Eliza `7743504b`'s
`packages/ui/src/voice/draft-transcript-guard.ts`.
[Recorded transcription](./recordedTranscription.md) supplies the
recognition callback. The guard receives the exact transcript,
original draft and composition result from that callback.

## Story: Keep what I typed when the recognizer returns

### A capture can apply words only to the revision and generation it began on

Every observed draft change advances a revision. Observing the same
text has no effect. Starting a capture saves the exact original draft
and revision and issues a new generation. Invalidation and another
start both retire old callbacks.

For a current generation with the original revision, compose from the
original draft and the latest transcript. A prior applied preview
does not advance the revision or become the basis for composition.
With a changed revision, a preview is ignored and final text becomes
a conflict result containing the exact recognition text, leaving the
typed draft intact. A retired generation is ignored even on final.
The guard itself does not consume its callback on final. Capture
finalization and review invalidation are supplied by its owner.

```quint
type DraftDisposition = DraftApplied | DraftConflict | DraftIgnored
type DraftState = { draftText: str, revision: int, generation: int, started: bool,
  originalText: str, originalRevision: int, lastDisposition: DraftDisposition, conflictText: str }
pure val initial: DraftState = { draftText: "", revision: 0, generation: 0, started: false,
  originalText: "", originalRevision: 0, lastDisposition: DraftIgnored, conflictText: "" }
pure def observeDraft(s: DraftState, nextDraftText: str): DraftState =
  if (s.draftText == nextDraftText) s else { ...s, draftText: nextDraftText, revision: s.revision + 1 }
pure def beginDraftCapture(s: DraftState): DraftState =
  { ...s, generation: s.generation + 1, started: true, originalText: s.draftText,
    originalRevision: s.revision }
pure def invalidateDraftCapture(s: DraftState): DraftState =
  { ...s, generation: s.generation + 1, started: false }
type DraftObservation = { currentTicket: bool, isFinal: bool, spokenText: str, composedText: str }
pure val previewDraft: DraftObservation = { currentTicket: true, isFinal: false, spokenText: "spoken", composedText: "draft spoken" }
pure val draftObservationValues = Set(previewDraft, { ...previewDraft, isFinal: true },
  { ...previewDraft, currentTicket: false }, { ...previewDraft, currentTicket: false, isFinal: true },
  { ...previewDraft, spokenText: "later", composedText: "draft later" })
pure val nextDraftTextValues = Set("", "draft", "edited", "draft spoken", "draft later")
pure def draftDisposition(started: bool, currentTicket: bool, revisionUnchanged: bool, isFinal: bool): DraftDisposition =
  if (not(started and currentTicket)) DraftIgnored
  else if (revisionUnchanged) DraftApplied
  else if (isFinal) DraftConflict else DraftIgnored
pure def applyDraftTranscript(s: DraftState, draftObservation: DraftObservation): DraftState = {
  val decision = draftDisposition(s.started, draftObservation.currentTicket, s.revision == s.originalRevision, draftObservation.isFinal)
  { ...s, lastDisposition: decision,
    draftText: if (decision == DraftApplied) draftObservation.composedText else s.draftText,
    conflictText: if (decision == DraftConflict) draftObservation.spokenText else "" }
}
pure def alwaysDraftRevisionsAreOrdered(s: DraftState): bool =
  s.originalRevision >= 0 and s.revision >= s.originalRevision and
    s.generation >= 0 and (s.started implies s.generation > 0)
pure def stepSpokenWordsPreserveRevisionAndBase(before: DraftState, via: str, after: DraftState): bool =
  via == "applyDraftTranscript" implies after.revision == before.revision and
    after.originalText == before.originalText and after.originalRevision == before.originalRevision
pure def stepRefusedWordsPreserveDraft(before: DraftState, via: str, after: DraftState): bool =
  via == "applyDraftTranscript" and after.lastDisposition != DraftApplied implies
    after.draftText == before.draftText
pure def lawFinalAfterEditKeepsRecognizedText(started: bool, currentTicket: bool): bool =
  (draftDisposition(started, currentTicket, false, true) == DraftConflict) == (started and currentTicket)
pure def sometimesSpeechApplied(s: DraftState): bool = s.lastDisposition == DraftApplied
pure def sometimesManualDraftPreserved(s: DraftState): bool = s.lastDisposition == DraftConflict
pure val weight_beginDraftCapture = 3
pure val weight_applyDraftTranscript = 5
```

The draft is compared by exact text. The machine treats the callback
identity and the host's composed text as port evidence. Grace owns
where to display conflict text and when an accepted transcript may
be reviewed or sent.
