# Speech route

Every spoken reply, read-aloud and dictation is heard through one route,
chosen when its turn begins: the owner's own speech provider when a
Cartesia key is installed, the hosted speech service for a signed-in
account whose plan allows it, and otherwise this device, whose
transcription and synthesis are always packaged. A network route that
fails before any audio hands its turn to the device once, and keeps the
failing key off the network for a while; once audio has played, or when
the person cancels, nothing falls back. Requests, the provider wire, the
audio and the clock stay in the shell, which reports what it observed.
Speech output on the device is [speech output](./speechOutput.md).

## Story: Hear a reply on the admitted speech route

> As the owner talking to my phone, I want each reply spoken through the
> route my account and keys admit, spoken on this phone when that route
> fails before I hear anything, and never by a second voice once one has
> started, so that a network failure leaves a chance to hear the answer
locally without hearing it twice.

### The owner's speech key speaks first, then a usable hosted account, then this device

A hold keeps its own key's network route on the device until it lapses;
a plan or rate limit keeps the hosted route on the device while it is in
force. A device supplied with no usable network credential selects the local
route.

```quint
type SpeechRoute = DeviceRoute | CloudRoute | DirectRoute
type NetworkKey = NoNetworkKey | CloudKey({ credential: int }) | DirectKey({ revision: int })
type ServiceLimit = NoServiceLimit | LimitedUntil({ untilMs: int }) | LimitedUntilCleared
type SpeechHold = NoSpeechHold | HeldUntil({ heldKey: NetworkKey, untilMs: int })
type SpeechTurn = Quiet | Speaking({ route: SpeechRoute, turnKey: NetworkKey, audible: bool, fellBack: bool })
type TurnEnding = NotEnded | SpokeOn({ route: SpeechRoute }) | FailedOn({ route: SpeechRoute }) | TurnCancelled
type SpeechRouting = { key: NetworkKey, limit: ServiceLimit, hold: SpeechHold, clock: int, turn: SpeechTurn, ending: TurnEnding, turns: int }
pure val initial: SpeechRouting = { key: NoNetworkKey, limit: NoServiceLimit, hold: NoSpeechHold, clock: 0, turn: Quiet, ending: NotEnded, turns: 0 }
pure def heldAt(hold: SpeechHold, key: NetworkKey, nowMs: int): bool = match hold { | HeldUntil(h) => h.heldKey == key and h.untilMs > nowMs | NoSpeechHold => false }
pure def limitedAt(limit: ServiceLimit, nowMs: int): bool = match limit { | NoServiceLimit => false | LimitedUntil(l) => l.untilMs > nowMs | LimitedUntilCleared => true }
pure def routeFor(key: NetworkKey, limit: ServiceLimit, hold: SpeechHold, nowMs: int): SpeechRoute = match key {
  | NoNetworkKey => DeviceRoute
  | DirectKey(_) => if (heldAt(hold, key, nowMs)) DeviceRoute else DirectRoute
  | CloudKey(_) => if (heldAt(hold, key, nowMs) or limitedAt(limit, nowMs)) DeviceRoute else CloudRoute
}
pure def later(s: SpeechRouting, nowMs: int): int = if (nowMs > s.clock) nowMs else s.clock
pure val nowMsValues = Set(0, 30000, 90000, 700000)
pure val keyValues = Set(NoNetworkKey, CloudKey({ credential: 1 }), CloudKey({ credential: 2 }), DirectKey({ revision: 1 }))
pure val limitValues = Set(NoServiceLimit, LimitedUntil({ untilMs: 60000 }), LimitedUntilCleared)
pure val holdValues = Set(NoSpeechHold, HeldUntil({ heldKey: CloudKey({ credential: 1 }), untilMs: 60000 }), HeldUntil({ heldKey: DirectKey({ revision: 1 }), untilMs: 600000 }))
pure def canKeyChanged(s: SpeechRouting, key: NetworkKey): bool = key != s.key
pure def keyChanged(s: SpeechRouting, key: NetworkKey): SpeechRouting = { ...s, key: key }
pure def canLimitChanged(s: SpeechRouting, limit: ServiceLimit): bool = limit != s.limit
pure def limitChanged(s: SpeechRouting, limit: ServiceLimit): SpeechRouting = { ...s, limit: limit }
pure def canBeginTurn(s: SpeechRouting, nowMs: int): bool = s.turn == Quiet and nowMs >= 0
pure def beginTurn(s: SpeechRouting, nowMs: int): SpeechRouting = {
  val at = later(s, nowMs)
  { ...s, clock: at, turn: Speaking({ route: routeFor(s.key, s.limit, s.hold, at), turnKey: s.key, audible: false, fellBack: false }), ending: NotEnded, turns: s.turns + 1 }
}
pure def lawWithoutAKeyTheDeviceSpeaks(limit: ServiceLimit, hold: SpeechHold, nowMs: int): bool = routeFor(NoNetworkKey, limit, hold, nowMs) == DeviceRoute
pure def lawAHeldKeySpeaksOnTheDevice(key: NetworkKey, limit: ServiceLimit, hold: SpeechHold, nowMs: int): bool =
  heldAt(hold, key, nowMs) implies routeFor(key, limit, hold, nowMs) == DeviceRoute
pure def lawALimitNeverKeepsTheOwnersKeyOff(revision: int, limit: ServiceLimit, nowMs: int): bool =
  routeFor(DirectKey({ revision: revision }), limit, NoSpeechHold, nowMs) == DirectRoute
pure val revisionValues = Set(1, 2)
pure def stepTheClockNeverGoesBack(before: SpeechRouting, after: SpeechRouting): bool = after.clock >= before.clock
```

### A turn is heard only on the route admitted when it began

Audio from any other route is refused, so a late answer from a route the
turn left never plays beside the one that replaced it.

```quint
pure def speaking(t: SpeechTurn): bool = t != Quiet
pure def routeOf(t: SpeechTurn): SpeechRoute = match t { | Speaking(x) => x.route | Quiet => DeviceRoute }
pure def turnKeyOf(t: SpeechTurn): NetworkKey = match t { | Speaking(x) => x.turnKey | Quiet => NoNetworkKey }
pure def audibleOf(t: SpeechTurn): bool = match t { | Speaking(x) => x.audible | Quiet => false }
pure def fellBackOf(t: SpeechTurn): bool = match t { | Speaking(x) => x.fellBack | Quiet => false }
pure def canAudioStarted(s: SpeechRouting, route: SpeechRoute): bool = speaking(s.turn) and routeOf(s.turn) == route and not(audibleOf(s.turn))
pure def audioStarted(s: SpeechRouting, route: SpeechRoute): SpeechRouting = {
  val t = s.turn
  match t { | Speaking(x) => { ...s, turn: Speaking({ ...x, audible: true }) } | Quiet => s }
}
pure def stepAudioIsHeardOnlyOnTheAdmittedRoute(before: SpeechRouting, via: str, after: SpeechRouting): bool =
  (audibleOf(after.turn) and not(audibleOf(before.turn))) implies (via == "audioStarted" and routeOf(after.turn) == routeOf(before.turn))
pure def stepAudibleSpeechKeepsItsRoute(before: SpeechRouting, after: SpeechRouting): bool =
  (audibleOf(before.turn) and speaking(after.turn)) implies routeOf(after.turn) == routeOf(before.turn)
```

### A network route that fails before audio hands its turn to this device once and holds its key off the network

An unreachable or failing server holds the key for a minute, a refused
account for ten minutes, and a rate limit for its stated wait, at most an
hour; a sign-in that lapsed falls back without a hold. A refused request,
no speech or an unconfirmed cleanup is not the route's failure: the turn
ends failed and nothing falls back.

```quint
type SpeechFailure = Offline | ServerFailed | AccountRefused | RateLimited({ retryAfterMs: int }) | SignInNeeded | NoSpeech | CleanupUnconfirmed | RequestRefused
pure val briefHoldMs = 60000
pure val accountHoldMs = 600000
pure val longestHoldMs = 3600000
pure def holdMsFor(failure: SpeechFailure): int = match failure {
  | Offline => briefHoldMs
  | ServerFailed => briefHoldMs
  | AccountRefused => accountHoldMs
  | RateLimited(r) => if (r.retryAfterMs <= 0) briefHoldMs else if (r.retryAfterMs > longestHoldMs) longestHoldMs else r.retryAfterMs
  | _ => 0
}
pure def fallsBack(failure: SpeechFailure): bool = match failure { | NoSpeech => false | CleanupUnconfirmed => false | RequestRefused => false | _ => true }
pure val failureValues = Set(Offline, AccountRefused, RateLimited({ retryAfterMs: 5000 }), RateLimited({ retryAfterMs: 7200000 }), SignInNeeded, RequestRefused)
pure def canNetworkFailed(s: SpeechRouting, failure: SpeechFailure, nowMs: int): bool =
  speaking(s.turn) and routeOf(s.turn) != DeviceRoute and not(audibleOf(s.turn)) and nowMs >= 0
pure def networkFailed(s: SpeechRouting, failure: SpeechFailure, nowMs: int): SpeechRouting = {
  val at = later(s, nowMs)
  val t = s.turn
  match t {
    | Speaking(x) => if (fallsBack(failure))
        { ...s, clock: at, turn: Speaking({ ...x, route: DeviceRoute, fellBack: true }),
          hold: if (holdMsFor(failure) > 0) HeldUntil({ heldKey: x.turnKey, untilMs: at + holdMsFor(failure) }) else s.hold }
      else { ...s, clock: at, turn: Quiet, ending: FailedOn({ route: x.route }) }
    | Quiet => s
  }
}
pure def lawAHoldLastsAtMostAnHour(failure: SpeechFailure): bool = holdMsFor(failure) >= 0 and holdMsFor(failure) <= longestHoldMs
pure def holdBounded(s: SpeechRouting): bool = {
  val h = s.hold
  match h { | HeldUntil(x) => x.heldKey != NoNetworkKey and x.untilMs <= s.clock + longestHoldMs | NoSpeechHold => true }
}
pure def alwaysAFallenBackTurnSpeaksOnTheDevice(s: SpeechRouting): bool =
  (fellBackOf(s.turn) implies routeOf(s.turn) == DeviceRoute)
  and ((speaking(s.turn) and routeOf(s.turn) != DeviceRoute) implies turnKeyOf(s.turn) != NoNetworkKey)
  and holdBounded(s)
pure def stepOnlyAFailureBeforeAudioFallsBack(before: SpeechRouting, via: str, after: SpeechRouting): bool =
  (fellBackOf(after.turn) and not(fellBackOf(before.turn))) implies (via == "networkFailed" and not(audibleOf(before.turn)) and routeOf(before.turn) != DeviceRoute)
```

### Once audio started, or when the person cancels, the turn ends on its route and holds nothing

A turn speaking on the device, or one whose audio started, fails where it
is. A cancellation is the person's, never the route's.

```quint
pure def canSpeechFinished(s: SpeechRouting): bool = audibleOf(s.turn)
pure def speechFinished(s: SpeechRouting): SpeechRouting = { ...s, turn: Quiet, ending: SpokeOn({ route: routeOf(s.turn) }) }
pure def canSpeechFailed(s: SpeechRouting): bool = speaking(s.turn) and (audibleOf(s.turn) or routeOf(s.turn) == DeviceRoute)
pure def speechFailed(s: SpeechRouting): SpeechRouting = { ...s, turn: Quiet, ending: FailedOn({ route: routeOf(s.turn) }) }
pure def canSpeechCancelled(s: SpeechRouting): bool = speaking(s.turn)
pure def speechCancelled(s: SpeechRouting): SpeechRouting = { ...s, turn: Quiet, ending: TurnCancelled }
pure def stepAnEndedTurnHoldsNothingNew(before: SpeechRouting, via: str, after: SpeechRouting): bool =
  (via == "speechCancelled" or via == "speechFailed" or via == "speechFinished") implies after.hold == before.hold
```

### A hold belongs to the key that failed, lapses at its time, and lifts when the device cannot speak

A changed account or key is not held by another key's failure. When the
device turns out to be unable to speak, the network route is all there is,
so its hold is lifted.

```quint
pure def canHoldLifted(s: SpeechRouting): bool = s.hold != NoSpeechHold
pure def holdLifted(s: SpeechRouting): SpeechRouting = { ...s, hold: NoSpeechHold }
pure val otherValues = keyValues
pure val untilMsValues = Set(60000, 600000)
pure def lawAHoldNeverKeepsAnotherKeyOff(key: NetworkKey, other: NetworkKey, untilMs: int, nowMs: int): bool =
  key != other implies not(heldAt(HeldUntil({ heldKey: other, untilMs: untilMs }), key, nowMs))
pure def lawAHoldLapsesAtItsTime(key: NetworkKey, untilMs: int, nowMs: int): bool =
  nowMs >= untilMs implies not(heldAt(HeldUntil({ heldKey: key, untilMs: untilMs }), key, nowMs))
```

### A reply can be spoken on each route, fall back to the device under a hold, and be cancelled without one

```quint
pure def sometimesFellBackAndSpokeLocally(s: SpeechRouting): bool = s.ending == SpokeOn({ route: DeviceRoute }) and s.hold != NoSpeechHold
pure def sometimesSpokeOnTheCloud(s: SpeechRouting): bool = s.ending == SpokeOn({ route: CloudRoute })
pure def sometimesSpokeWithTheOwnersKey(s: SpeechRouting): bool = s.ending == SpokeOn({ route: DirectRoute })
pure def sometimesALimitKeepsTheCloudOff(s: SpeechRouting): bool =
  s.key == CloudKey({ credential: 1 }) and limitedAt(s.limit, s.clock) and speaking(s.turn) and routeOf(s.turn) == DeviceRoute and not(fellBackOf(s.turn))
pure def sometimesCancelledWithoutAHold(s: SpeechRouting): bool = s.ending == TurnCancelled and s.hold == NoSpeechHold and s.turns >= 1
pure def sometimesARefusedRequestDoesNotFallBack(s: SpeechRouting): bool = s.ending == FailedOn({ route: CloudRoute })
```
