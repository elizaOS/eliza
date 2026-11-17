# Microphone

On Android, live capture and the draft recorder share one process-wide
microphone slot. This spec owns the slot, its reservation tokens, the
handoff from a running live capture to a draft, and what the host hears of
a live capture's start and end. The Java shell (`voice-io`) keeps the
recorder, the audio source and the threads; it reports each source's
opening and each release receipt as an event, and it holds the reservation
token so that only the lease that took the slot can free it. The device
client of cloud speech (`spec/os/voice/cloudSpeech.md`) reserves the slot
as a live capture through this machine.

## Story: Share the microphone between live capture and dictation

> As a person using voice in more than one place on my phone, I want only
> one of them to hold the microphone at a time, and a stuck release never
> to hand my microphone to someone else.

### One user holds the slot, and every other reservation is refused while it does

A reservation succeeds only on a free slot and takes the next token, so a
held slot always carries the newest token. A reservation on a held slot is
refused as busy and changes nothing else.

```quint
type MicUser = NoUser | LiveCapture | DraftRecorder
type SlotPhase = Free | Opening | Running | Closing | Unconfirmed
type Slot = { user: MicUser, phase: SlotPhase, token: int }
type Refusal = NoRefusal | SlotBusy | FencedReopen
type DraftHandoff = NoDraft | Draining | DraftAdmitted | DraftRefused
type HostReport = Unreported | StartReported | EndReported
type Microphone = { slot: Slot, issued: int, refusal: Refusal, reopenFenced: bool, draft: DraftHandoff, report: HostReport }
pure val freeSlot: Slot = { user: NoUser, phase: Free, token: 0 }
pure val initial: Microphone = { slot: freeSlot, issued: 0, refusal: NoRefusal, reopenFenced: false, draft: NoDraft, report: Unreported }
pure def canReserve(m: Microphone, user: MicUser, reopen: bool): bool = user != NoUser and (reopen implies user == LiveCapture)
pure def reserve(m: Microphone, user: MicUser, reopen: bool): Microphone =
  if (m.slot.phase != Free) { ...m, refusal: SlotBusy }
  else if (reopen and m.reopenFenced) { ...m, refusal: FencedReopen }
  else { ...m, slot: { user: user, phase: Opening, token: m.issued + 1 }, issued: m.issued + 1, refusal: NoRefusal, reopenFenced: m.reopenFenced and user == DraftRecorder, draft: if (m.draft == DraftAdmitted) NoDraft else m.draft, report: Unreported }
pure def canOpened(m: Microphone): bool = m.slot.phase == Opening
pure def opened(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: Running }, report: if (m.slot.user == LiveCapture) StartReported else m.report }
pure def liveCaptureRunning(m: Microphone): bool = m.slot.user == LiveCapture and m.slot.phase == Running
pure def alwaysHeldSlotHasNewestToken(m: Microphone): bool =
  m.issued >= 0 and (if (m.slot.phase == Free) m.slot == freeSlot else m.slot.user != NoUser and m.slot.token == m.issued and m.slot.token > 0)
pure def sometimesSecondUserRefused(m: Microphone): bool = m.refusal == SlotBusy and m.slot.phase != Free
pure def sometimesSlotReused(m: Microphone): bool = m.issued >= 2 and m.slot.phase == Running
```

### The slot is freed only by the release receipt of its own token

Cancelling an opening or running capture starts closing it; a source that
finishes opening after its cancellation is not reopened. A release receipt
frees the slot only when it carries the holder's token; an earlier lease's
receipt changes nothing. A release that cannot be confirmed leaves the slot
held. Only the draft recorder may retry an unconfirmed release; an
unconfirmed live capture keeps the slot for the rest of the process.

```quint
pure def canCancel(m: Microphone): bool = m.slot.phase == Opening or m.slot.phase == Running
pure def cancel(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: Closing }, report: if (m.report == StartReported) EndReported else m.report }
pure def canReleased(m: Microphone, token: int): bool =
  token >= 1 and token <= m.issued and (m.slot.phase == Opening or m.slot.phase == Closing or (m.slot.phase == Unconfirmed and m.slot.user == DraftRecorder))
pure def released(m: Microphone, token: int): Microphone =
  if (token == m.slot.token) { ...m, slot: freeSlot, draft: if (m.draft == Draining) DraftAdmitted else m.draft } else m
pure val tokenValues = Set(1, 2, 3)
pure def canReleaseUnconfirmed(m: Microphone): bool = m.slot.phase == Opening or m.slot.phase == Closing
pure def releaseUnconfirmed(m: Microphone): Microphone = { ...m, slot: { ...m.slot, phase: Unconfirmed }, draft: if (m.draft == Draining) DraftRefused else m.draft }
pure def stepSlotFreesOnlyByReceipt(before: Microphone, via: str, after: Microphone): bool =
  (before.slot.phase != Free and after.slot.phase == Free) implies via == "released"
pure def stepUnconfirmedLiveCaptureKeepsSlot(before: Microphone, after: Microphone): bool =
  (before.slot.phase == Unconfirmed and before.slot.user == LiveCapture) implies after.slot == before.slot
pure def sometimesUnconfirmedLiveCaptureHoldsSlot(m: Microphone): bool = m.slot.phase == Unconfirmed and m.slot.user == LiveCapture and m.refusal == SlotBusy
```

### A closing capture always reports its outcome

While source events keep arriving, a closing capture leaves closing:
released, or held unconfirmed.

```quint
pure val fair_released = "weak"
pure val fair_releaseUnconfirmed = "weak"
pure def leadsToClosingSettles(m: Microphone, later: Microphone): bool = m.slot.phase == Closing implies later.slot.phase != Closing
```

### The host hears a live capture's end only after it heard its start

A live capture's start is reported to its host when its source opens, and
its end when it stops running, once. A capture cancelled before it opened
leaves no trace: no start and no end.

```quint
pure def alwaysStartReportedOnlyWhileRunning(m: Microphone): bool = (m.report == StartReported) == liveCaptureRunning(m)
pure def stepEndFollowsStart(before: Microphone, after: Microphone): bool =
  (after.report == EndReported and before.report != EndReported) implies before.report == StartReported
pure def sometimesEndReported(m: Microphone): bool = m.report == EndReported
pure def sometimesCancelledBeforeStartLeavesNoTrace(m: Microphone): bool = m.slot.user == LiveCapture and m.slot.phase == Closing and m.report == Unreported
```

## Story: Dictate a draft while live capture was running

> As a person who starts dictating while the assistant was listening, I
> want the earlier capture released before my draft records, and the
> assistant never to reopen its microphone over my draft.

### A draft records only after the earlier capture's release is confirmed

A draft request fences automatic reopening and stops a live capture that
holds the slot; it is admitted at once on a free slot. While it drains, the
live capture still holds the slot, so the draft recorder is refused as
busy. The live capture's release receipt admits the draft; an unconfirmed
release refuses it. A draft cannot be requested while the draft recorder
already holds the slot.

```quint
pure def canRequestDraft(m: Microphone): bool = m.draft != Draining and m.slot.user != DraftRecorder
pure def requestDraft(m: Microphone): Microphone =
  if (m.slot.phase == Free) { ...m, draft: DraftAdmitted, reopenFenced: true }
  else if (m.slot.phase == Unconfirmed) { ...m, draft: DraftRefused, reopenFenced: true }
  else { ...m, slot: { ...m.slot, phase: Closing }, draft: Draining, reopenFenced: true, report: if (m.report == StartReported) EndReported else m.report }
pure def alwaysDrainingWaitsOnLiveCapture(m: Microphone): bool = m.draft == Draining implies m.slot.user == LiveCapture and m.slot.phase == Closing and m.reopenFenced
pure def alwaysAdmittedDraftFindsFreeSlot(m: Microphone): bool = m.draft == DraftAdmitted implies m.slot.phase == Free and m.reopenFenced
pure def sometimesDraftWaitsForRelease(m: Microphone): bool = m.draft == Draining and m.refusal == SlotBusy
pure def sometimesDraftRecordsAfterLiveCapture(m: Microphone): bool = m.slot.user == DraftRecorder and m.slot.phase == Running and m.reopenFenced and m.issued >= 2
pure def sometimesFailedReleaseRefusesDraft(m: Microphone): bool = m.draft == DraftRefused and m.slot.phase == Unconfirmed and m.slot.user == LiveCapture
pure val weight_requestDraft = 3
```

### Automatic reopening stays refused from a draft request until the person starts live capture

Only a live capture the person started lifts the fence; an automatic
reopen while it is up is refused, also after the draft has released the
microphone.

```quint
pure def stepOnlyThePersonLiftsTheFence(before: Microphone, via: str, after: Microphone): bool =
  (before.reopenFenced and not(after.reopenFenced)) implies (via == "reserve" and after.slot.user == LiveCapture and after.slot.phase == Opening)
pure def sometimesReopenRefusedAfterDraft(m: Microphone): bool = m.refusal == FencedReopen and m.slot.phase == Free and m.draft == NoDraft
```

### A requested draft always settles

While source events keep arriving, a draining draft request ends admitted
or refused.

```quint
pure def leadsToDraftSettles(m: Microphone, later: Microphone): bool = m.draft == Draining implies later.draft != Draining
```
