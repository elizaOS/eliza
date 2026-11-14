# Alpha's Maps planning and navigation custody

Alpha's `maps-adapter.ts` binds the Eliza Maps client's `DeviceMapsNavigation`,
`NavigationRelay`, current location, search, route and guidance interfaces.
Sources include `plugins/plugin-maps/src/client/{device-navigation,navigation-relay,navigation-fix,agent-navigation}.ts`.
The old `MapsNavigation`, `MapsRerouteOwnership`, `MapsNavigationGuidanceReadback`,
`MapsConnection` and `ResidentMapsRelayOffer` models are indexed in
[the source inventory](../alphaBaseline.json). Maps' provider validation,
route geometry, coordinate codecs, location watches and OS speech retain
separate shell conformance obligations.

## Story: Plan directions on my phone and keep me in control of guidance

### A valid agent request prepares a route and never turns on guidance itself

An accepted agent request belongs to the active authenticated turn and
current Maps owner, with exact destination and supported travel mode.
The phone displays the target and asks for current location only through
its UI. The request uses existing permission and a precise fix no older
than 30 seconds, no more than five seconds in the future, and with
accuracy at most 50 meters. It publishes awaiting-location when no
suitable granted fix exists. If the owner or route sheet changes while
waiting, the response cannot replace the displayed route. Only a newly
planned route for the exact destination and mode reaches confirmation.
Beginning guidance requires the owner's own confirmation. An active
session excludes another plan. A reroute belongs to that exact active
session, and losing the session or failing to acquire a precise point
keeps the previous route or reports unavailability.

```quint
type Fix = { present: bool, precise: bool, age: int, accuracy: int }
type Travel = Drive | Walk | Bicycle | Transit
type PlanAdmission = { ownerId: int, destination: str, travel: Travel, providerReady: bool, modeSupported: bool, validReference: bool }
type PlanReceipt = { route: int, destination: str, travel: Travel }
type DirectionsPhase = Idle | AwaitingFix | Planning | Confirm | Guiding | Rerouting | Refused
pure val idlePhase: DirectionsPhase = Idle
pure val awaitingPhase: DirectionsPhase = AwaitingFix
pure val planningPhase: DirectionsPhase = Planning
pure val confirmPhase: DirectionsPhase = Confirm
pure val guidingPhase: DirectionsPhase = Guiding
pure val refusedPhase: DirectionsPhase = Refused
type Directions = { owner: int, ticket: int, selection: int, capturedSelection: int, destination: str, travel: Travel, phase: DirectionsPhase, active: bool, route: int }
pure val initial: Directions = { owner: 0, ticket: 0, selection: 0, capturedSelection: 0, destination: "", travel: Drive, phase: Idle, active: false, route: 0 }
pure val planValues = Set(
  { ownerId: 1, destination: "park", travel: Walk, providerReady: true, modeSupported: true, validReference: true },
  { ownerId: 2, destination: "shop", travel: Drive, providerReady: true, modeSupported: true, validReference: true },
  { ownerId: 1, destination: "park", travel: Transit, providerReady: true, modeSupported: false, validReference: true }
)
pure val fixValues = Set({ present: true, precise: true, age: 100, accuracy: 50 }, { present: true, precise: true, age: 30001, accuracy: 10 }, { present: true, precise: false, age: 0, accuracy: 10 }, { present: true, precise: true, age: -5001, accuracy: 10 }, { present: false, precise: false, age: 0, accuracy: 0 })
pure def usableFix(fix: Fix): bool = fix.present and fix.precise and fix.age >= -5000 and fix.age <= 30000 and fix.accuracy >= 0 and fix.accuracy <= 50
pure def lawApproximateFixCannotPlan(fix: Fix): bool = not(fix.precise) implies not(usableFix(fix))
pure def canStartPlan(s: Directions, plan: PlanAdmission): bool =
  not(s.active) and plan.ownerId > 0 and plan.destination != "" and plan.providerReady and plan.modeSupported and plan.validReference
pure def startPlan(s: Directions, plan: PlanAdmission): Directions =
  { ...s, owner: plan.ownerId, ticket: s.ticket + 1, selection: s.selection + 1, capturedSelection: s.selection + 1,
    destination: plan.destination, travel: plan.travel, phase: awaitingPhase, route: 0 }
pure def canRetire(s: Directions): bool = s.owner > 0
pure def retire(s: Directions): Directions = { ...initial, ticket: s.ticket + 1, selection: s.selection + 1 }
pure def canSelectionChanges(s: Directions): bool = s.owner > 0 and not(s.active)
pure def selectionChanges(s: Directions): Directions = { ...s, selection: s.selection + 1, route: 0, phase: refusedPhase }
pure def canReceiveFix(s: Directions, ticket: int, fix: Fix, alreadyGranted: bool): bool =
  s.phase == AwaitingFix and ticket == s.ticket and s.selection == s.capturedSelection and alreadyGranted and usableFix(fix)
pure def receiveFix(s: Directions, ticket: int, fix: Fix, alreadyGranted: bool): Directions = { ...s, phase: planningPhase }
pure def canPlanSettles(s: Directions, ticket: int): bool = s.phase == Planning and ticket == s.ticket and s.selection == s.capturedSelection
pure def planSettles(s: Directions, ticket: int, result: PlanReceipt): Directions = {
  val exact = result.route > 0 and result.destination == s.destination and result.travel == s.travel
  { ...s, phase: if (exact) confirmPhase else refusedPhase, route: if (exact) result.route else 0 }
}
pure def canConfirmGuidance(s: Directions): bool = s.phase == Confirm and s.route > 0
pure def confirmGuidance(s: Directions): Directions = { ...s, phase: guidingPhase, active: true }
pure def canStartReroute(s: Directions, fix: Fix): bool = s.phase == Guiding and usableFix(fix)
pure def startReroute(s: Directions, fix: Fix): Directions = { ...s, phase: Rerouting, ticket: s.ticket + 1 }
pure def canRerouteSettles(s: Directions, ticket: int): bool = s.phase == Rerouting and ticket == s.ticket
pure def rerouteSettles(s: Directions, ticket: int, route: int, sameSession: bool): Directions =
  { ...s, phase: guidingPhase, route: if (sameSession and route > 0) route else s.route }
pure def canStop(s: Directions): bool = s.phase != Idle
pure def stop(s: Directions): Directions = { ...s, phase: idlePhase, active: false, route: 0, ticket: s.ticket + 1 }
pure val routeValues = Set(0, 1, 2)
pure val resultValues = Set({ route: 1, destination: "park", travel: Walk }, { route: 2, destination: "shop", travel: Drive }, { route: 0, destination: "stale", travel: Transit })
pure val weight_receiveFix = 5
pure val weight_planSettles = 5
pure val weight_confirmGuidance = 5
pure val weight_startReroute = 5
pure val ticketValues = Set(1, 2, 3, 4, 5, 6)
pure def alwaysGuidanceHasRoute(s: Directions): bool =
  (s.active == (s.phase == Guiding or s.phase == Rerouting)) and ((s.active or s.phase == Confirm) implies s.route > 0)
pure def alwaysWorkHasOwner(s: Directions): bool = s.phase != Idle implies s.owner > 0 and s.destination != ""
pure def alwaysPendingSelectionIsCaptured(s: Directions): bool =
  (s.phase == AwaitingFix or s.phase == Planning or s.phase == Confirm) implies s.selection == s.capturedSelection
pure def stepOnlyOwnerConfirmationStartsGuidance(before: Directions, via: str, after: Directions): bool =
  not(before.active) and after.active implies via == "confirmGuidance" and before.phase == Confirm
pure def stepUnsettledRerouteKeepsCurrentPath(before: Directions, via: str, after: Directions): bool =
  via == "startReroute" implies after.route == before.route
pure def sometimesRouteAwaitsConfirmation(s: Directions): bool = s.phase == Confirm
pure def sometimesReroutes(s: Directions): bool = s.phase == Rerouting
```

### A route sheet retains a destination while its owner is attached

Discovered by the proof: the selection callback could otherwise be
applied to a fabricated idle record with an owner but no captured
destination. Stopping a route retains the presented destination. Closing
or replacing its owner clears the route sheet entirely.

```quint
pure def alwaysAttachedHasDestination(s: Directions): bool = s.owner > 0 implies s.destination != ""
```

### A resident relay delivers each command at most once within its offer

A relay opens for one authenticated conversation and a captured Maps
controller. The server must acknowledge protocol 1 with no outstanding
command before a connected report. Unknown, repeated or expired request IDs
fail before execution. The receipt is sent at most once because the native
operation might already have run. Cancellation and controller replacement
fence late results. Retire is idempotent and best effort. The relay
validates native results and connection identity independently of the
agent's response publication. HTTP timeouts and request arbitration are
external effects.

```quint
type RelayEvidence = { protocol: int, currentOffer: bool, currentOwner: bool, requestIdValid: bool, alreadyDelivered: bool, expiresIn: int }
pure val relayValues = Set(
  { protocol: 1, currentOffer: true, currentOwner: true, requestIdValid: true, alreadyDelivered: false, expiresIn: 2000 },
  { protocol: 1, currentOffer: true, currentOwner: true, requestIdValid: true, alreadyDelivered: true, expiresIn: 2000 },
  { protocol: 1, currentOffer: true, currentOwner: true, requestIdValid: true, alreadyDelivered: false, expiresIn: 0 }
)
pure def admitRelay(relay: RelayEvidence): bool = relay.protocol == 1 and relay.currentOffer and relay.currentOwner and relay.requestIdValid and not(relay.alreadyDelivered) and relay.expiresIn > 0
pure def commandBudget(expiresIn: int): int = if (expiresIn < 1) 1 else if (expiresIn > 30000) 30000 else expiresIn
pure def lawRelayDoesNotRepeatDeviceAction(relay: RelayEvidence): bool = relay.alreadyDelivered implies not(admitRelay(relay))
pure def lawCommandLifetimeBounded(expiresIn: int): bool = commandBudget(expiresIn) >= 1 and commandBudget(expiresIn) <= 30000
```
