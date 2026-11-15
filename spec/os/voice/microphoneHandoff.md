# Microphone handoff to the draft recorder

The on-device speech controller hands the microphone from a running native
capture to the draft recorder, and later from the draft back to a live
capture the person asks for. All of it runs on the controller's serial
worker. The original capture may still be starting when the draft is
requested. The [microphone slot](./microphoneSlot.md) is the process-wide
reservation underneath; [voice capture](./capture.md) owns the turn.

## Story: Dictate a draft while a live capture was running

> As a person who starts dictating while the assistant was listening, I
> want the earlier capture released before my draft records, and the
> assistant never to reopen its microphone over my draft.

### The draft records only after the earlier capture's release is confirmed

A draft request fences automatic reopening and asks the earlier capture to
stop; a capture still starting finishes opening first and is then stopped.
The draft is acknowledged only once the earlier capture reports it released
the microphone and the host is still open. A failed release, or a retired
host, refuses the draft. A reservation queued before the request does not
clear its fence. The earlier capture holds the microphone from the moment
it finishes starting until its release is confirmed; a failed release
leaves it holding the microphone.

```quint
type EarlierCapture = EarlierStarting | EarlierRunning | EarlierStopping | EarlierReleased | EarlierFailed
type LiveRequest = LiveIdle | FinishingDraft | AcquiringLive | LiveAcquired | LiveRefused
type Handoff = { earlier: EarlierCapture, earlierOwns: bool, requested: bool, fence: bool, draft: bool,
  acknowledged: bool, refused: bool, staleQueued: bool, autoRefused: bool, hostOpen: bool,
  user: LiveRequest, live: bool }
pure val initial: Handoff = { earlier: EarlierStarting, earlierOwns: false, requested: false, fence: false, draft: false,
  acknowledged: false, refused: false, staleQueued: true, autoRefused: false, hostOpen: true,
  user: LiveIdle, live: false }
pure def canRequestDraft(h: Handoff): bool = not(h.requested) and h.user == LiveIdle
pure def requestDraft(h: Handoff): Handoff = { ...h, requested: true, fence: true }
pure def canFinishEarlierStart(h: Handoff): bool = h.earlier == EarlierStarting
pure def finishEarlierStart(h: Handoff): Handoff = { ...h, earlier: EarlierRunning, earlierOwns: true }
pure def canStopEarlier(h: Handoff): bool = h.requested and h.earlier == EarlierRunning
pure def stopEarlier(h: Handoff): Handoff = { ...h, earlier: EarlierStopping }
pure def canReleaseEarlier(h: Handoff): bool = h.earlier == EarlierStopping
pure def releaseEarlier(h: Handoff): Handoff = { ...h, earlier: EarlierReleased, earlierOwns: false }
pure def canFailEarlierRelease(h: Handoff): bool = h.earlier == EarlierStopping
pure def failEarlierRelease(h: Handoff): Handoff = { ...h, earlier: EarlierFailed }
pure def canSettleDrain(h: Handoff): bool =
  h.requested and not(h.acknowledged) and not(h.refused) and (h.earlier == EarlierReleased or h.earlier == EarlierFailed)
pure def settleDrain(h: Handoff): Handoff =
  if (h.earlier == EarlierReleased and h.hostOpen) { ...h, draft: true, acknowledged: true }
  else { ...h, refused: true }
pure def canStaleStart(h: Handoff): bool = h.requested and h.staleQueued
pure def staleStart(h: Handoff): Handoff = { ...h, staleQueued: false }
pure def canRetireHost(h: Handoff): bool = h.hostOpen
pure def retireHost(h: Handoff): Handoff = { ...h, hostOpen: false }
pure def alwaysReleaseReceiptPrecedesDraft(h: Handoff): bool =
  (h.acknowledged or h.draft or h.live) implies h.earlier == EarlierReleased and not(h.earlierOwns) and h.requested
pure def alwaysEarlierOwnershipMatchesPhase(h: Handoff): bool =
  h.earlierOwns == (h.earlier == EarlierRunning or h.earlier == EarlierStopping or h.earlier == EarlierFailed)
pure def alwaysFailedReleaseFencesDraft(h: Handoff): bool =
  h.earlier == EarlierFailed implies not(h.draft) and not(h.live) and not(h.acknowledged)
pure def stepStaleStartKeepsFence(before: Handoff, via: str, after: Handoff): bool =
  via == "staleStart" implies after.fence == before.fence
pure def sometimesDraftAcknowledged(h: Handoff): bool = h.draft and h.acknowledged
pure def sometimesFailedReleaseRefused(h: Handoff): bool = h.refused and h.earlier == EarlierFailed
```

### Automatic reopening is refused while the draft holds the microphone

The fence set by the draft request stays up until the person asks for live
capture. While it is up an automatic reopen is refused.

```quint
pure def canAutomaticReopen(h: Handoff): bool = h.draft and h.fence
pure def automaticReopen(h: Handoff): Handoff = { ...h, autoRefused: true }
pure def alwaysReopenFenced(h: Handoff): bool = (h.requested and h.user == LiveIdle) implies h.fence
pure def sometimesAutomaticReopenRefused(h: Handoff): bool = h.autoRefused and h.draft
```

### One microphone owner at a time

The person's live request first finishes the draft and only then acquires
live capture, which a retired host refuses. The earlier capture, the draft
and live capture never hold the microphone together.

```quint
pure def canRequestUserLive(h: Handoff): bool = h.draft and h.hostOpen and h.user == LiveIdle
pure def requestUserLive(h: Handoff): Handoff = { ...h, user: FinishingDraft, fence: false }
pure def canFinishDraft(h: Handoff): bool = h.user == FinishingDraft
pure def finishDraft(h: Handoff): Handoff = { ...h, draft: false, user: AcquiringLive }
pure def canAcquireLive(h: Handoff): bool = h.user == AcquiringLive
pure def acquireLive(h: Handoff): Handoff =
  if (h.hostOpen) { ...h, live: true, user: LiveAcquired } else { ...h, user: LiveRefused }
pure def alwaysOneMicrophoneOwner(h: Handoff): bool =
  not(h.earlierOwns and (h.draft or h.live)) and not(h.draft and h.live)
pure def alwaysLiveFollowsFinishedDraft(h: Handoff): bool =
  (h.user != LiveIdle implies h.acknowledged) and
  ((h.user == AcquiringLive or h.user == LiveAcquired or h.user == LiveRefused) implies not(h.draft)) and
  (h.live implies h.user == LiveAcquired)
pure def sometimesLiveAfterDraft(h: Handoff): bool = h.live
```

### A requested draft always settles

When the earlier capture keeps starting, stopping and releasing, and the
drain is settled, a draft request ends acknowledged or refused.

```quint
pure val fair_finishEarlierStart = "weak"
pure val fair_stopEarlier = "weak"
pure val fair_releaseEarlier = "weak"
pure val fair_settleDrain = "weak"
pure def leadsToDrainSettles(h: Handoff, later: Handoff): bool =
  h.requested implies (later.acknowledged or later.refused)
```
