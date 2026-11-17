# Wake listening

The device can listen for a wake phrase in a separately signed listener
application, outside the assistant's own process; its Android service
lifecycle is [listener foreground](./listenerForeground.md). After a wake
the interface's wake window holds the microphone open for one exchange,
and the native bridge decides whether an arrival may start a voice session
at all. A wake starts a fresh exchange; it never resumes earlier work or
supplies an approval, which [the voice session](../../agent/actions/voiceApproval.md) keeps off
the voice channel. Wake listening is a consumer's choice; when it is off,
the assistant asks the installed listener to turn off at startup.

## Story: Keep wake listening on the device under the person's control

> As a person who turned on wake listening, I want it to run only in a
> listener I consented to, with no special exemptions, and to stop when I
> pause it.

### Only the separately signed listener is privileged, with exactly two privileged permissions

The trusted listener package must match its identity: its expected signer, and
the permission that protects its control interface. Its only
privileged permissions are hotword audio capture
(`CAPTURE_AUDIO_HOTWORD`) and starting activities from the background
(`START_ACTIVITIES_FROM_BACKGROUND`). A listener holding any other
privileged permission is not trusted. An enabled exported settings
activity must belong to that package and UID, or the listener is not
trusted either.

```quint
type ListenerGrant = { identityMatches: bool, settingsOwned: bool, hotwordCapture: bool, backgroundStart: bool, otherPrivilege: bool,
  recordAudioConsented: bool, notificationsConsented: bool, indicatorExempt: bool, powerExempt: bool,
  ownDomain: bool, domainOpensSockets: bool, domainSharesPrivileged: bool }
pure def privilegedExactly(grant: ListenerGrant): bool =
  grant.identityMatches and grant.settingsOwned and grant.hotwordCapture and grant.backgroundStart and not(grant.otherPrivilege)
pure def lawExtraPrivilegeIsNeverTrusted(grant: ListenerGrant): bool =
  grant.otherPrivilege implies not(privilegedExactly(grant))
```

### Recording audio and notifications need the person's consent, with no indicator or power exemption

`RECORD_AUDIO` and the listening notification are runtime grants the
person gives. The listener never holds a role that hides the microphone
indicator, and never an exemption from battery optimization.

```quint
pure def consentedWithoutExemption(grant: ListenerGrant): bool =
  grant.recordAudioConsented and grant.notificationsConsented and not(grant.indicatorExempt) and not(grant.powerExempt)
pure def lawIndicatorAlwaysShows(grant: ListenerGrant): bool =
  grant.indicatorExempt implies not(consentedWithoutExemption(grant))
```

### The listener runs confined to its own SELinux domain

The image's policy gives the listener, selected by its signer and package
as a privileged install, a domain of its own with its own private data.
That domain cannot create network sockets and belongs to no network,
privileged-app, platform-app or audio hardware domain; it reaches consent,
notifications, app operations and audio capture only through named system
services. A listener running in any other domain is not trusted, and an
image is released only with that domain observed enforcing on the device.

```quint
pure def confinedDomain(grant: ListenerGrant): bool =
  grant.ownDomain and not(grant.domainOpensSockets) and not(grant.domainSharesPrivileged)
pure def lawNetworkedListenerNeverTrusted(grant: ListenerGrant): bool =
  grant.domainOpensSockets implies not(confinedDomain(grant))
```

### Listening starts only in an admitted listener

Listening begins only when the listener is privileged exactly as above,
confined to its own domain and consented without exemption. Starting to listen opens no
microphone window of its own: that needs a wake.

```quint
type WakePhase = WakeIdle | WakeOpen | AwaitingReply
type Wake = { listening: bool, stopConfirmed: bool, phase: WakePhase, openedAt: int, awaitingSince: int,
  generation: int, consumed: bool, starts: int, sentUtterances: int, crashExits: int, tripped: bool }
pure val initial: Wake = { listening: false, stopConfirmed: false, phase: WakeIdle, openedAt: 0, awaitingSince: 0,
  generation: 0, consumed: true, starts: 0, sentUtterances: 0, crashExits: 0, tripped: false }
pure def listenerAdmitted(grant: ListenerGrant): bool =
  privilegedExactly(grant) and confinedDomain(grant) and consentedWithoutExemption(grant)
pure def windowClosed(listening: bool, w: Wake): Wake =
  { ...w, listening: listening, phase: WakeIdle, openedAt: 0, awaitingSince: 0 }
pure def canStartListening(w: Wake, grant: ListenerGrant): bool = not(w.listening) and not(w.tripped) and listenerAdmitted(grant)
pure def startListening(w: Wake, grant: ListenerGrant): Wake = { ...w, listening: true, stopConfirmed: false }
pure val admittedGrant: ListenerGrant = { identityMatches: true, settingsOwned: true, hotwordCapture: true, backgroundStart: true, otherPrivilege: false,
  recordAudioConsented: true, notificationsConsented: true, indicatorExempt: false, powerExempt: false,
  ownDomain: true, domainOpensSockets: false, domainSharesPrivileged: false }
pure val grantValues = Set(admittedGrant, { ...admittedGrant, identityMatches: false }, { ...admittedGrant, settingsOwned: false }, { ...admittedGrant, otherPrivilege: true },
  { ...admittedGrant, recordAudioConsented: false }, { ...admittedGrant, indicatorExempt: true }, { ...admittedGrant, domainOpensSockets: true })
pure def sometimesListening(w: Wake): bool = w.listening
```

### The status chip can pause listening but never start it

The system status chip and the assistant's bridge can pause listening,
turn it off, or hand off to the listener's own settings. A resume request
from the chip does nothing: only the listener's own consented start can
begin listening. Pausing or turning off closes any open wake window, so a
listener that is not listening holds no microphone.

```quint
type ChipCommand = ChipPause | ChipTurnOff | ChipResume | ChipOpenSettings
pure def chipCommand(w: Wake, command: ChipCommand): Wake =
  if (command == ChipPause or command == ChipTurnOff) windowClosed(false, w) else w
pure def stepChipNeverStartsListening(before: Wake, via: str, after: Wake): bool =
  via == "chipCommand" implies (after.listening implies before.listening)
pure def alwaysPausedListenerHoldsNoWindow(w: Wake): bool = not(w.listening) implies w.phase == WakeIdle
```

### A stop is confirmed only by a timely absent or OFF reply with the microphone closed

App startup asks the installed listener to turn off. Only a reply in time
that reports the listener absent or saved OFF, with both listening and
microphone open false, confirms that the listener stopped. A stop that
timed out or failed, bridge absence included, never confirms, whatever
reply arrives, and an unknown, active or contradictory reply never
confirms either; each leaves a visible unconfirmed stop. Sending one
native request per stop, and treating a reply after the stop settled,
malformed status or an incomplete acknowledgement as a failure, are
adapter obligations.

```quint
type ListenerReply = ListenerAbsent | ListenerSavedOff | ListenerUnknown | ListenerActive | ListenerContradictory
type StopSettlement = StopByReply | StopTimedOut | StopFailed
type ListenerStatus = { settlement: StopSettlement, reply: ListenerReply, reportsListening: bool, microphoneOpen: bool }
pure def listenerStopped(status: ListenerStatus): bool =
  status.settlement == StopByReply and (status.reply == ListenerAbsent or status.reply == ListenerSavedOff) and
    not(status.reportsListening or status.microphoneOpen)
pure def reportStatus(w: Wake, status: ListenerStatus): Wake =
  if (listenerStopped(status)) { ...windowClosed(false, w), stopConfirmed: true } else { ...w, stopConfirmed: false }
pure val stoppedStatus: ListenerStatus = { settlement: StopByReply, reply: ListenerSavedOff, reportsListening: false, microphoneOpen: false }
pure val statusValues = Set(stoppedStatus, { ...stoppedStatus, microphoneOpen: true }, { ...stoppedStatus, reply: ListenerAbsent },
  { ...stoppedStatus, settlement: StopTimedOut }, { ...stoppedStatus, settlement: StopFailed, reply: ListenerAbsent },
  { ...stoppedStatus, reply: ListenerContradictory })
pure def lawNoStopClaimWithOpenMicrophone(status: ListenerStatus): bool =
  status.microphoneOpen implies not(listenerStopped(status))
pure def lawTimeoutNeverConfirms(status: ListenerStatus): bool =
  status.settlement != StopByReply implies not(listenerStopped(status))
pure def lawUnsafeReplyNeverConfirms(status: ListenerStatus): bool =
  (status.reply == ListenerUnknown or status.reply == ListenerActive or status.reply == ListenerContradictory) implies not(listenerStopped(status))
pure def alwaysConfirmedStopIsNotListening(w: Wake): bool = w.stopConfirmed implies not(w.listening)
pure def sometimesStopConfirmed(w: Wake): bool = w.stopConfirmed and w.generation > 0
```

### Three crashes while capturing within ten minutes stop listening until the person turns it on

Android restarts the persistent listener after every crash. A process
start that finds its capture session still marked open counts as an
unclean exit, unless the mark was written in another boot or by another
install of the listener, since a shutdown, a reboot and an update all end
the process without a clean stop. Unclean exits older than ten minutes no
longer count. At three that count, listening stops, any wake window
closes, and listening stays off until the person turns it on again from
the listener's own consent.

```quint
type ProcessStart = { markerOpen: bool, sameBoot: bool, sameInstall: bool }
pure def uncleanExit(markerOpen: bool, sameBoot: bool, sameInstall: bool): bool = markerOpen and sameBoot and sameInstall
pure val startValues = Set({ markerOpen: true, sameBoot: true, sameInstall: true }, { markerOpen: false, sameBoot: true, sameInstall: true },
  { markerOpen: true, sameBoot: false, sameInstall: true }, { markerOpen: true, sameBoot: true, sameInstall: false })
pure def restartListenerProcess(w: Wake, start: ProcessStart): Wake = {
  val exits = w.crashExits + (if (uncleanExit(start.markerOpen, start.sameBoot, start.sameInstall)) 1 else 0)
  if (exits >= 3) { ...windowClosed(false, w), crashExits: 3, tripped: true, stopConfirmed: false }
  else { ...w, crashExits: exits }
}
pure def canForgetOldCrashes(w: Wake): bool = w.crashExits > 0 and not(w.tripped)
pure def forgetOldCrashes(w: Wake): Wake = { ...w, crashExits: 0 }
pure def canTurnListeningBackOn(w: Wake, grant: ListenerGrant): bool = w.tripped and listenerAdmitted(grant)
pure def turnListeningBackOn(w: Wake, grant: ListenerGrant): Wake = { ...w, tripped: false, crashExits: 0, listening: true, stopConfirmed: false }
pure def lawRebootOrUpdateIsNotACrash(markerOpen: bool, sameInstall: bool): bool =
  not(uncleanExit(markerOpen, false, sameInstall)) and not(uncleanExit(markerOpen, true, false))
pure def alwaysTrippedListenerIsOff(w: Wake): bool =
  w.crashExits >= 0 and w.crashExits <= 3 and (w.tripped implies not(w.listening) and w.phase == WakeIdle) and
    (w.crashExits == 3 implies w.tripped)
pure def stepOnlyThePersonEndsATrip(before: Wake, via: str, after: Wake): bool =
  before.tripped and not(after.tripped) implies via == "turnListeningBackOn"
pure def sometimesCrashLoopTripped(w: Wake): bool = w.tripped and w.generation > 0
```

### Capture continues only under a fresh, attributed indicator lease

The system UI holds a lease that says the listening indicator is visible.
The listener stamps each renewal with its own monotonic clock; a lease
not renewed within 3 seconds expires, and a lease of another boot, one
not yet acknowledged, revoked or replaced never counts. Capture may
continue only while the lease is live and the indicator's surface is
shown. A hidden indicator with a reason the system UI states (the display
off, a full-screen app, the shade expanded, or a screen transition) is a
pause; any other hidden surface, an unknown display state while the
screen is interactive, or a recording the indicator has not attributed to
the listener 2.5 seconds after capture opened, is a loss. Both release
the microphone. The lease carries visibility facts only: it can withhold
capture and never starts listening.

```quint
type LeaseVerdict = LeaseAllowsCapture | LeasePause | LeaseLoss
type IndicatorLease = { live: bool, sameBoot: bool, acknowledged: bool, msToExpiry: int, displayKnown: bool, displayOn: bool,
  screenInteractive: bool, surfaceShown: bool, chipShown: bool, recordingSeen: bool, hiddenExplained: bool, captureMs: int }
pure val attributionWindowMs = 2500
pure def leaseVerdict(lease: IndicatorLease): LeaseVerdict =
  if (not(lease.live) or not(lease.sameBoot) or not(lease.acknowledged) or lease.msToExpiry <= 0) LeaseLoss
  else if (not(lease.displayKnown)) (if (lease.screenInteractive) LeaseLoss else LeasePause)
  else if (not(lease.displayOn)) LeasePause
  else if (not(lease.surfaceShown) or (lease.recordingSeen and not(lease.chipShown))) (if (lease.hiddenExplained) LeasePause else LeaseLoss)
  else if (lease.captureMs >= attributionWindowMs and not(lease.recordingSeen and lease.chipShown)) LeaseLoss
  else LeaseAllowsCapture
pure val shownLease: IndicatorLease = { live: true, sameBoot: true, acknowledged: true, msToExpiry: 2000, displayKnown: true, displayOn: true,
  screenInteractive: true, surfaceShown: true, chipShown: true, recordingSeen: true, hiddenExplained: false, captureMs: 3000 }
pure val leaseValues = Set(shownLease, { ...shownLease, msToExpiry: 0 }, { ...shownLease, sameBoot: false }, { ...shownLease, acknowledged: false },
  { ...shownLease, surfaceShown: false }, { ...shownLease, surfaceShown: false, hiddenExplained: true }, { ...shownLease, displayKnown: false },
  { ...shownLease, chipShown: false, recordingSeen: false }, { ...shownLease, chipShown: false, recordingSeen: false, captureMs: 2499 })
pure def lawCaptureNeedsAFreshLease(lease: IndicatorLease): bool =
  leaseVerdict(lease) == LeaseAllowsCapture implies lease.live and lease.sameBoot and lease.acknowledged and lease.msToExpiry > 0 and lease.surfaceShown
pure def lawUnattributedCaptureStops(lease: IndicatorLease): bool =
  lease.captureMs >= attributionWindowMs and not(lease.recordingSeen and lease.chipShown) implies leaseVerdict(lease) != LeaseAllowsCapture
pure def lawFreshCaptureHasItsWindow(lease: IndicatorLease): bool =
  leaseVerdict({ ...lease, captureMs: 0 }) == LeaseAllowsCapture or leaseVerdict(lease) != LeaseAllowsCapture
```

## Story: Hold the microphone open for one wake window

> As a person who said the wake phrase, I want the assistant to listen for
> what I say next, and to stop listening if I say nothing or once it has
> answered.

### Only a person's wake phrase opens a fresh window

A wake detected while listening opens a new window at the time of the
detection, with a new generation that has not yet started voice. The
assistant's own playback and other media never count as a wake.

```quint
type WakeSource = HumanWake | OwnPlayback | OtherPlayback
pure def wakeSourceAccepted(source: WakeSource): bool = source == HumanWake
pure def canDetectWake(w: Wake, now: int, source: WakeSource): bool = w.listening and wakeSourceAccepted(source)
pure def detectWake(w: Wake, now: int, source: WakeSource): Wake =
  { ...w, phase: WakeOpen, openedAt: now, awaitingSince: 0, generation: w.generation + 1, consumed: false }
pure val nowValues = Set(0, 7999, 8000, 29999, 30000, 38000)
pure def lawPlaybackNeverWakes(source: WakeSource): bool = source != HumanWake implies not(wakeSourceAccepted(source))
pure def stepWakeOpensFreshWindow(before: Wake, via: str, after: Wake): bool =
  via == "detectWake" implies
    after.phase == WakeOpen and after.awaitingSince == 0 and after.generation == before.generation + 1 and not(after.consumed)
pure def sometimesWindowOpen(w: Wake): bool = w.phase == WakeOpen
```

### Speech in an open window waits for the reply, and speech outside one is ignored

A finished utterance while the window is open moves it to waiting for the
assistant's reply. An utterance while no window is open changes nothing.

```quint
pure def hearFinal(w: Wake, now: int): Wake =
  if (w.phase == WakeIdle) w
  else { ...w, phase: AwaitingReply, awaitingSince: now, sentUtterances: w.sentUtterances + 1 }
pure def stepSpeechOutsideWindowIgnored(before: Wake, via: str, after: Wake): bool =
  via == "hearFinal" and before.phase == WakeIdle implies after == before
pure def sometimesAwaitingReply(w: Wake): bool = w.phase == AwaitingReply
```

### Wake audio stays on the device and never becomes a transcript

The wake detector runs on the device. Audio before and during the wake
phrase is neither saved nor sent to a speech or model service. Only an
utterance finished inside an open window is sent, one at a time.

```quint
pure def stepOnlyWindowSpeechIsSent(before: Wake, via: str, after: Wake): bool =
  after.sentUtterances != before.sentUtterances implies
    via == "hearFinal" and before.phase != WakeIdle and after.sentUtterances == before.sentUtterances + 1
pure def alwaysSentCountValid(w: Wake): bool = w.sentUtterances >= 0
```

### The window closes on a reply, a reset, the idle timeout or the safety cap

The assistant's reply closes the window. A reset (the microphone turned
off, wake disabled or the interface unmounted) closes it at once. A clock
observation closes a window open 30 seconds or more in any phase, and a
window still waiting for speech after 8 seconds. Clock observations may
move backwards and then close nothing. A closed window holds no times.

```quint
pure val wakeIdleTimeoutMs = 8000
pure val wakeMaxWindowMs = 30000
pure def windowExpired(w: Wake, now: int): bool =
  w.phase != WakeIdle and
    (now - w.openedAt >= wakeMaxWindowMs or (w.phase == WakeOpen and now - w.openedAt >= wakeIdleTimeoutMs))
pure def agentResponded(w: Wake): Wake = if (w.phase == WakeIdle) w else windowClosed(w.listening, w)
pure def resetWindow(w: Wake): Wake = windowClosed(w.listening, w)
pure def tickWindow(w: Wake, now: int): Wake = if (windowExpired(w, now)) windowClosed(w.listening, w) else w
pure def alwaysIdleWindowHoldsNoClock(w: Wake): bool =
  w.phase == WakeIdle implies w.openedAt == 0 and w.awaitingSince == 0
pure val openWindowValues = Set({ ...initial, listening: true, phase: WakeOpen, openedAt: 1000, generation: 1, consumed: false },
  { ...initial, listening: true, phase: AwaitingReply, openedAt: 1000, awaitingSince: 5000, generation: 1, consumed: false })
pure def lawSafetyCapClosesWindow(openWindow: Wake, now: int): bool =
  openWindow.phase != WakeIdle and now - openWindow.openedAt >= wakeMaxWindowMs implies tickWindow(openWindow, now).phase == WakeIdle
pure def lawSilentWindowClosesAfterIdleTimeout(openWindow: Wake, now: int): bool =
  openWindow.phase == WakeOpen and now - openWindow.openedAt >= wakeIdleTimeoutMs implies tickWindow(openWindow, now).phase == WakeIdle
pure def lawYoungWindowStaysOpen(openWindow: Wake, now: int): bool =
  now - openWindow.openedAt < wakeIdleTimeoutMs implies tickWindow(openWindow, now) == openWindow
pure def sometimesWindowTimedOut(w: Wake): bool = w.listening and w.phase == WakeIdle and w.generation > 0
```

## Story: Start voice only from a verified wake

> As a person, I want only a genuine wake to start a voice conversation,
> once, and only while my phone is unlocked and the assistant is in front.

### Only a verified listener, identity-sharing system UI or warm power entry starts voice

The optional wake entry policy must be on. Android supplies the caller's
identity. Recognized origins are a verified listener, platform-signed
system UI with its identity published, or a permission-protected warm
power entry. Other callers merely open the assistant. Warm arrivals have
a five-second window. A cold trusted listener or system UI arrival can be
held for up to 15 seconds when native startup admitted the same nonsecret
owner as the later authenticated session. Cold power entry is refused.
Lock at arrival or consumption, background, changed scope, an obsoleted
native bridge or renderer generation and an unavailable voice controller
refuse a voice start. The renderer controller serializes operations with
a ten-second bridge deadline and cannot use a timed-out callback to
replace a current session. The native bridge binds an opaque digest, and
the host rechecks foreground and conversation readiness before starting
its voice controller. Android signer, callbacks, clock reads and
microphone state remain platform observations.

```quint
type WakeOrigin = VerifiedListener | VerifiedSystem | ProtectedPower | OrdinaryAssist
type WakeEvidence = { policyOn: bool, currentBinder: bool, freshScope: bool, unlocked: bool, inFront: bool, ready: bool,
  cold: bool, matchedNativeOwner: bool, age: int, wakeGeneration: int }
pure val warmWake: WakeEvidence = { policyOn: true, currentBinder: true, freshScope: true, unlocked: true, inFront: true, ready: true,
  cold: false, matchedNativeOwner: true, age: 100, wakeGeneration: 1 }
pure val wakeValues = Set(warmWake, { ...warmWake, policyOn: false }, { ...warmWake, age: 5001 },
  { ...warmWake, cold: true, age: 15000 }, { ...warmWake, cold: true, age: 15000, matchedNativeOwner: false },
  { ...warmWake, unlocked: false }, { ...warmWake, wakeGeneration: 2 })
pure def voiceAuthorized(origin: WakeOrigin, wake: WakeEvidence): bool =
  wake.policyOn and wake.currentBinder and wake.freshScope and wake.unlocked and wake.inFront and wake.ready and
    origin != OrdinaryAssist and wake.age >= 0 and
    (if (wake.cold) origin != ProtectedPower and wake.matchedNativeOwner and wake.age <= 15000 else wake.age <= 5000)
pure def lawNoNativeWakeWhenPolicyOff(origin: WakeOrigin, wake: WakeEvidence): bool =
  not(wake.policyOn) implies not(voiceAuthorized(origin, wake))
pure def lawColdWakeNeedsNativeOwner(origin: WakeOrigin, wake: WakeEvidence): bool =
  wake.cold and voiceAuthorized(origin, wake) implies wake.matchedNativeOwner and origin != ProtectedPower
pure def lawOrdinaryAssistOnlyOpens(wake: WakeEvidence): bool = not(voiceAuthorized(OrdinaryAssist, wake))
pure def lawLockedWakeRefused(origin: WakeOrigin, wake: WakeEvidence): bool =
  not(wake.unlocked) implies not(voiceAuthorized(origin, wake))
```

### A wake starts voice at most once, within its open window

A voice start consumes the current window's wake. It needs the window to
be open and the evidence to name the current wake generation, so a stale
arrival from an earlier wake is refused. Over any history there are never
more voice starts than wakes.

```quint
pure def canStartVoice(w: Wake, origin: WakeOrigin, wake: WakeEvidence): bool =
  voiceAuthorized(origin, wake) and w.phase != WakeIdle and not(w.consumed) and wake.wakeGeneration == w.generation
pure def startVoice(w: Wake, origin: WakeOrigin, wake: WakeEvidence): Wake = { ...w, consumed: true, starts: w.starts + 1 }
pure def alwaysOneVoiceStartPerWake(w: Wake): bool =
  w.starts >= 0 and (if (w.consumed) w.starts <= w.generation else w.starts < w.generation)
pure def sometimesVoiceStartedFromWake(w: Wake): bool = w.starts > 0 and w.phase != WakeIdle
```
