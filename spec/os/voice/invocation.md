# Voice invocation

Which launch of the assistant may start a voice turn. The native sense
bridge records each launch of the assistant surface (an arrival) and the
signed-in renderer takes it once. Only a wake from the admitted image
listener, an assistant gesture that the platform-signed system UI launched
with its identity shared, or a press from the consumer's
permission-protected power activity can start voice; every other launch
only opens the assistant. This follows `SenseInvocation.java` and
`listenerStartsVoice` of `plugins/plugin-native-system` on develop.

Android supplies the caller's package, signer and keyguard state, and the
monotonic clock; the shell turns them into the events below. The renderer
binds an opaque in-memory digest of its signed-in session, never a
credential, and the native owner is the host's non-secret account binding.
Bridge and renderer generations stay in the shell: a late call from a
replaced WebView never reaches this machine.

## Story: Start voice from a trusted gesture, once

> As an owner, I want only a genuine wake, assistant gesture or power press
> to start a voice conversation, once, and only while my phone is unlocked,
> so that nothing else can open my microphone.

### Only a listener wake, a system assistant gesture or a protected power press is a voice origin

A launch by any other app, and any launch while the device is locked, has
the origin `Assist`: it opens the assistant and nothing more.

```quint
type Origin = Listener | System | Power | Assist
type Caller = SenseListener | SystemUi | PowerActivity | OtherApp
type ListenerAdmission = ListenerAdmitted | ListenerUnavailable
pure def originOf(caller: Caller, admission: ListenerAdmission, locked: bool): Origin =
  if (locked) Assist
  else if (caller == SenseListener) (if (admission == ListenerAdmitted) Listener else Assist)
  else if (caller == SystemUi) System
  else if (caller == PowerActivity) Power
  else Assist
pure def startsVoice(origin: Origin): bool = origin == Listener or origin == System or origin == Power
pure def lawLockedArrivalOnlyOpens(caller: Caller, admission: ListenerAdmission): bool = originOf(caller, admission, true) == Assist
pure def lawOtherAppsOnlyOpen(admission: ListenerAdmission, locked: bool): bool = originOf(OtherApp, admission, locked) == Assist
```

### Without an admitted listener a listener launch only opens the assistant

On an image that does not declare the listener feature, or whose listener is
not same-signer with its control permission, the sense bridge answers
`Unavailable` and never starts capture (`voice/listener.md` owns capture).
Admission is observed again whenever the bridge asks.

```quint
pure def lawUnavailableListenerOnlyOpens(locked: bool): bool = originOf(SenseListener, ListenerUnavailable, locked) == Assist
```

### A warm arrival belongs to the current session and starts voice within 5,000 ms

An arrival while a renderer session is bound waits for that session alone.
A new session, or the renderer signing out, drops it. Taking it while the
device is locked or the assistant is not in front only opens the assistant.

```quint
pure val warmWindowMs = 5000
pure val coldWindowMs = 15000
type Binding = Unbound | Bound({ session: int })
type OwnerAdmission = NoOwner | AdmittedOwner({ account: int })
type Pending =
  NoArrival
  | Warm({ origin: Origin, session: int, arrival: int, age: int })
  | Cold({ origin: Origin, account: int, arrival: int, age: int })
  | Adopted({ origin: Origin, session: int, account: int, arrival: int, age: int })
type Claim = WarmClaim | AdoptedClaim
type Answer = NoAnswer | OpenOnly({ arrival: int }) | VoiceStart({ origin: Origin, arrival: int, claim: Claim, age: int })
type Invocation = { binding: Binding, owner: OwnerAdmission, listenerAdmission: ListenerAdmission, pending: Pending, arrivals: int, lastVoiceArrival: int, answer: Answer }
pure val initial: Invocation = { binding: Unbound, owner: NoOwner, listenerAdmission: ListenerUnavailable, pending: NoArrival, arrivals: 0, lastVoiceArrival: 0, answer: NoAnswer }
pure val sessionValues = Set(1, 2)
pure val accountValues = Set(1, 2)
pure val msValues = Set(1000, 4500, 10000)
pure def ownerIs(owner: OwnerAdmission, account: int): bool = match owner { | AdmittedOwner(o) => o.account == account | NoOwner => false }
pure def answerFor(p: Pending, owner: OwnerAdmission, locked: bool): Answer = match p {
  | Warm(w) => if (startsVoice(w.origin) and w.age <= warmWindowMs and not(locked)) VoiceStart({ origin: w.origin, arrival: w.arrival, claim: WarmClaim, age: w.age }) else OpenOnly({ arrival: w.arrival })
  | Adopted(a) => if (a.age <= coldWindowMs and not(locked) and ownerIs(owner, a.account)) VoiceStart({ origin: a.origin, arrival: a.arrival, claim: AdoptedClaim, age: a.age }) else OpenOnly({ arrival: a.arrival })
  | Cold(c) => OpenOnly({ arrival: c.arrival })
  | NoArrival => NoAnswer
}
pure def voiceArrival(a: Answer, fallback: int): int = match a { | VoiceStart(v) => v.arrival | _ => fallback }
pure def canBind(s: Invocation, session: int): bool = session > 0 and s.binding != Bound({ session: session })
pure def bind(s: Invocation, session: int): Invocation = { ...s, binding: Bound({ session: session }), pending: adoptOnBind(s.pending, s.owner, session) }
pure def canUnbind(s: Invocation): bool = s.binding != Unbound
pure def unbind(s: Invocation): Invocation = { ...s, binding: Unbound, pending: NoArrival }
pure def canElapse(s: Invocation, ms: int): bool = ms > 0
pure def elapse(s: Invocation, ms: int): Invocation = { ...s, pending: aged(s.pending, ms) }
pure def aged(p: Pending, ms: int): Pending = match p {
  | Warm(w) => Warm({ ...w, age: w.age + ms })
  | Cold(c) => Cold({ ...c, age: c.age + ms })
  | Adopted(a) => Adopted({ ...a, age: a.age + ms })
  | NoArrival => NoArrival
}
pure def canTake(s: Invocation, session: int, locked: bool): bool = s.binding == Bound({ session: session }) and s.pending != NoArrival
pure def take(s: Invocation, session: int, locked: bool): Invocation = {
  val a = answerFor(s.pending, s.owner, locked)
  { ...s, pending: NoArrival, answer: a, lastVoiceArrival: voiceArrival(a, s.lastVoiceArrival) }
}
pure def pendingMatchesBinding(p: Pending, b: Binding): bool = match p {
  | Warm(w) => b == Bound({ session: w.session })
  | Adopted(a) => b == Bound({ session: a.session })
  | Cold(c) => b == Unbound
  | NoArrival => true
}
pure def alwaysArrivalWaitsForItsOwnSession(s: Invocation): bool = pendingMatchesBinding(s.pending, s.binding)
pure def startWithinWindow(a: Answer): bool = match a { | VoiceStart(v) => startsVoice(v.origin) and v.age >= 0 and v.age <= (if (v.claim == WarmClaim) warmWindowMs else coldWindowMs) | _ => true }
pure def startedFrom(a: Answer, origin: Origin, claim: Claim): bool = match a { | VoiceStart(v) => v.origin == origin and v.claim == claim | _ => false }
pure def openedOnly(a: Answer): bool = match a { | OpenOnly(o) => o.arrival >= 1 | _ => false }
pure def alwaysVoiceStartWithinWindow(s: Invocation): bool = startWithinWindow(s.answer)
pure def sometimesWarmPowerStart(s: Invocation): bool = startedFrom(s.answer, Power, WarmClaim)
pure def sometimesListenerWakeStarts(s: Invocation): bool = startedFrom(s.answer, Listener, WarmClaim)
pure def sometimesArrivalOnlyOpens(s: Invocation): bool = openedOnly(s.answer)
```

### Each arrival is recorded with its origin and replaces any arrival still waiting

A power press is recorded only on a bound session: it is warm-only. With no
bound session, a listener or system arrival waits cold when the host has
admitted a native owner and the device is unlocked; anything else only
opens the assistant and is dropped.

```quint
pure def canArrive(s: Invocation, caller: Caller, locked: bool): bool = caller == PowerActivity implies s.binding != Unbound
pure def arrive(s: Invocation, caller: Caller, locked: bool): Invocation = {
  val origin = originOf(caller, s.listenerAdmission, locked)
  val n = s.arrivals + 1
  { ...s, arrivals: n, pending: recorded(s.binding, s.owner, origin, n) }
}
pure def recorded(binding: Binding, owner: OwnerAdmission, origin: Origin, n: int): Pending = match binding {
  | Bound(b) => Warm({ origin: origin, session: b.session, arrival: n, age: 0 })
  | Unbound => if (origin == Listener or origin == System) coldFor(owner, origin, n) else NoArrival
}
pure def coldFor(owner: OwnerAdmission, origin: Origin, n: int): Pending = match owner {
  | AdmittedOwner(o) => Cold({ origin: origin, account: o.account, arrival: n, age: 0 })
  | NoOwner => NoArrival
}
pure def canObserveListener(s: Invocation, admission: ListenerAdmission): bool = admission != s.listenerAdmission
pure def observeListener(s: Invocation, admission: ListenerAdmission): Invocation = { ...s, listenerAdmission: admission }
```

### A cold listener or system arrival waits up to 15,000 ms for the same owner and is adopted once

The first session bound within the window adopts it only if the host's
native owner then is the owner recorded at arrival, and the take checks the
owner again. A power press is never adopted from a cold wait.

```quint
pure def adoptOnBind(p: Pending, owner: OwnerAdmission, session: int): Pending = match p {
  | Cold(c) => if (c.age <= coldWindowMs and ownerIs(owner, c.account)) Adopted({ origin: c.origin, session: session, account: c.account, arrival: c.arrival, age: c.age }) else NoArrival
  | _ => NoArrival
}
pure def canAdmitOwner(s: Invocation, account: int): bool = account > 0 and not(ownerIs(s.owner, account))
pure def admitOwner(s: Invocation, account: int): Invocation = { ...s, owner: AdmittedOwner({ account: account }) }
pure def canWithdrawOwner(s: Invocation): bool = s.owner != NoOwner
pure def withdrawOwner(s: Invocation): Invocation = { ...s, owner: NoOwner }
pure def coldOrigin(p: Pending): bool = match p { | Cold(c) => c.origin == Listener or c.origin == System | Adopted(a) => a.origin == Listener or a.origin == System | _ => true }
pure def alwaysOnlyListenerOrSystemWaitsCold(s: Invocation): bool = coldOrigin(s.pending)
pure def adoptedBy(p: Pending, owner: OwnerAdmission): bool = match p { | Adopted(a) => ownerIs(owner, a.account) | _ => false }
pure def adoptedOwnerCurrent(s: Invocation): bool = adoptedBy(s.pending, s.owner)
pure def adoptedStart(a: Answer): bool = match a { | VoiceStart(v) => v.claim == AdoptedClaim | _ => false }
pure def stepAdoptedStartNeedsSameOwner(before: Invocation, via: str, after: Invocation): bool = (via == "take" and adoptedStart(after.answer)) implies adoptedOwnerCurrent(before)
pure def agedCold(p: Pending): bool = match p { | Cold(c) => c.age > 0 | _ => false }
pure def sometimesColdWaiting(s: Invocation): bool = agedCold(s.pending)
pure def sometimesAdoptedStart(s: Invocation): bool = adoptedStart(s.answer)
```

### A take while locked or out of view only opens the assistant

```quint
pure val ageValues = Set(0, 4500, 5001, 15001)
pure val arrivalValues = Set(1, 2)
pure def lawLockedTakeOnlyOpens(origin: Origin, session: int, arrival: int, age: int, owner: OwnerAdmission): bool =
  not(adoptedStart(answerFor(Adopted({ origin: origin, session: session, account: 1, arrival: arrival, age: age }), owner, true)))
  and answerFor(Warm({ origin: origin, session: session, arrival: arrival, age: age }), owner, true) == OpenOnly({ arrival: arrival })
pure val ownerValues = Set(NoOwner, AdmittedOwner({ account: 1 }), AdmittedOwner({ account: 2 }))
```

### Each arrival starts voice at most once

An arrival is consumed by the take that answers it, and a later take never
answers it again. Only a take starts voice, and only for an arrival newer
than every arrival that started voice before.

```quint
pure def pendingArrival(p: Pending): int = match p { | Warm(w) => w.arrival | Cold(c) => c.arrival | Adopted(a) => a.arrival | NoArrival => 0 }
pure def pendingAge(p: Pending): int = match p { | Warm(w) => w.age | Cold(c) => c.age | Adopted(a) => a.age | NoArrival => 0 }
pure def alwaysWaitingArrivalIsLatestAndUnused(s: Invocation): bool =
  0 <= s.lastVoiceArrival and s.lastVoiceArrival <= s.arrivals
  and (s.pending != NoArrival implies (pendingArrival(s.pending) == s.arrivals and s.lastVoiceArrival < s.arrivals and pendingAge(s.pending) >= 0))
pure def alwaysVoiceStartIsTheLastUsedArrival(s: Invocation): bool = isVoiceStart(s.answer) implies (voiceArrival(s.answer, 0) == s.lastVoiceArrival and s.lastVoiceArrival >= 1)
pure def stepEachArrivalStartsVoiceOnce(before: Invocation, via: str, after: Invocation): bool =
  after.lastVoiceArrival != before.lastVoiceArrival implies (via == "take" and after.lastVoiceArrival > before.lastVoiceArrival and after.pending == NoArrival)
```

## Story: Start voice only where I can see it

> As an owner, I want a voice turn to start only on an unlocked, visible
> assistant that is not busy, so that it never talks over a dialog or a call
> already in progress.

### The renderer starts voice from a voice answer only while unlocked, visible, with no dialog, no connection prompt and no active voice

The renderer calls this generated function with the bridge's answer and
what it sees; it rechecks because the screen can change after the take.

```quint
type Screen = { unlocked: bool, visible: bool, dialogOpen: bool, connectionPrompt: bool, voiceActive: bool }
pure def isVoiceStart(a: Answer): bool = match a { | VoiceStart(v) => true | _ => false }
pure def listenerStartsVoice(a: Answer, screen: Screen): bool =
  isVoiceStart(a) and screen.unlocked and screen.visible and not(screen.dialogOpen) and not(screen.connectionPrompt) and not(screen.voiceActive)
```
