# Network

The Network plugin handles member availability, updates and relays in conversations whose member, application and route have already been verified by the host. The Network service owns introductions, moderation and delivery. The operations follow `plugins/plugin-network/src/actions/`, `routing/authz.ts` and `backend/contract.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Set my availability using the dates in my own message

> As a Network member, I want the Network to apply the state and dates I asked for.

### Availability uses the member's own evidence and calendar window

The route parser supplies sanitized member words, the exact evidence span, any recognized availability cue, date-only epoch days in the member's time zone, and a stable message ID. Dates extracted from the member's words override the proposed dates. An open state clears the date window. A paused or busy proposal with a busy cue and no explicit pause becomes busy. An end day cannot precede today or equal or precede a future start day.

```quint
type Availability = OpenAvailability | BusyAvailability | TravelingAvailability | PausedAvailability
type AvailabilityCue = OpenCue | BusyCue | TravelCue | PauseCue | NoCue
type AvailabilityWindow = { begins: int, ends: int }
type NetworkQuoteScan = { offset: int, equal: bool }
type NetworkWords = { bodyUnits: List[int], quoteUnits: List[int], quoteOffset: int, cue: AvailabilityCue, statedWindow: AvailabilityWindow }
type AvailabilityRequest = { requested: Availability, suggested: AvailabilityWindow, words: NetworkWords, today: int }
pure val absentDay = -1
pure def exactNetworkQuote(words: NetworkWords): bool = words.quoteUnits.length() > 0 and words.quoteOffset >= 0 and words.quoteOffset + words.quoteUnits.length() <= words.bodyUnits.length() and words.quoteUnits.foldl({ offset: words.quoteOffset, equal: true }, (found, unit) => { offset: found.offset + 1, equal: found.equal and words.bodyUnits.nthOr(found.offset, -1) == unit }).equal
pure def networkCueSupports(wanted: Availability, cue: AvailabilityCue): bool = match wanted {
  | OpenAvailability => cue == OpenCue
  | BusyAvailability => cue == BusyCue or cue == PauseCue
  | TravelingAvailability => cue == TravelCue
  | PausedAvailability => cue == BusyCue or cue == PauseCue
}
pure def effectiveNetworkAvailability(request: AvailabilityRequest): Availability = if (request.requested == PausedAvailability and request.words.cue == BusyCue) BusyAvailability else request.requested
pure def networkDateFromWords(stated: int, suggested: int): int = if (stated == absentDay) suggested else stated
pure def networkWindow(request: AvailabilityRequest): AvailabilityWindow = {
  val begins = networkDateFromWords(request.words.statedWindow.begins, request.suggested.begins)
  val ends = networkDateFromWords(request.words.statedWindow.ends, request.suggested.ends)
  if (request.requested == OpenAvailability) { begins: absentDay, ends: absentDay }
  else { begins: if (begins == request.today) absentDay else begins, ends: ends }
}
pure def validNetworkAvailability(request: AvailabilityRequest): bool = {
  val begins = networkDateFromWords(request.words.statedWindow.begins, request.suggested.begins)
  val ends = networkDateFromWords(request.words.statedWindow.ends, request.suggested.ends)
  request.today >= 0 and exactNetworkQuote(request.words) and networkCueSupports(request.requested, request.words.cue) and (begins == absentDay or begins >= request.today) and (ends == absentDay or ends >= request.today) and (begins <= request.today or ends == absentDay or begins < ends)
}
pure val requestValues = Set({ requested: OpenAvailability, suggested: { begins: 5, ends: 8 }, words: { bodyUnits: List(1), quoteUnits: List(1), quoteOffset: 0, cue: OpenCue, statedWindow: { begins: -1, ends: -1 } }, today: 1 }, { requested: BusyAvailability, suggested: { begins: -1, ends: 5 }, words: { bodyUnits: List(1), quoteUnits: List(2), quoteOffset: 0, cue: BusyCue, statedWindow: { begins: -1, ends: -1 } }, today: 1 })
pure def lawOpenNetworkHasNoDates(request: AvailabilityRequest): bool = request.requested == OpenAvailability implies networkWindow(request) == { begins: absentDay, ends: absentDay }
```

### A stated weekday or day of the month is read on the member's own calendar

The route parser reads a date directly after "from", "until" or "through"
in the member's words, letter case aside and with a typographic apostrophe
read as a typed one: an ISO date `YYYY-MM-DD`, a weekday, or a day of the
month written "the 14th", "the 14" or "14th". A bare weekday names its next
occurrence after today, at most a week ahead. A weekday the member places
in next week names that weekday of the next calendar week, which starts on
Monday: "next Friday", "Friday next week", "Friday of next week", "Friday
Next Week", "next week Friday", "next week's Friday", "next week on Friday"
and "next week, on Friday" all do. A day of the month names its next
occurrence counting today, so "until the 14th" said on the 14th ends today
and "from the 14th until the 20th" said on the 14th starts today; a day the
month lacks moves to the next month that has it. In a range, a starting
weekday is in next week when the message says "next week" anywhere, and an
end weekday or day of the month that does not come after the start is read
again from the start, so "from next week Tuesday until Friday" ends on the
Friday after that Tuesday. Every other wording states no date, and the
proposed date applies.

```quint
pure def networkWeekday(epochDay: int): int = (epochDay + 4) % 7
pure def daysToNextMonday(today: int): int = if ((8 - networkWeekday(today)) % 7 == 0) 7 else (8 - networkWeekday(today)) % 7
pure def statedNetworkWeekday(today: int, weekday: int, nextWeek: bool): int =
  if (nextWeek) today + daysToNextMonday(today) + (weekday + 6) % 7
  else if ((weekday - networkWeekday(today) + 7) % 7 == 0) today + 7
  else today + (weekday - networkWeekday(today) + 7) % 7
pure val todayValues = Set(20737, 20738, 20739, 20740, 20741, 20742, 20743)
pure val weekdayValues = Set(0, 1, 2, 3, 4, 5, 6)
pure def lawABareWeekdayComesWithinAWeek(today: int, weekday: int): bool =
  (today >= 0 and weekday >= 0 and weekday <= 6) implies
    (statedNetworkWeekday(today, weekday, false) > today and statedNetworkWeekday(today, weekday, false) <= today + 7
      and networkWeekday(statedNetworkWeekday(today, weekday, false)) == weekday)
pure def lawANextWeekWeekdayIsInTheNextCalendarWeek(today: int, weekday: int): bool =
  (today >= 0 and weekday >= 0 and weekday <= 6) implies
    (statedNetworkWeekday(today, weekday, true) >= today + daysToNextMonday(today) and statedNetworkWeekday(today, weekday, true) < today + daysToNextMonday(today) + 7
      and networkWeekday(today + daysToNextMonday(today)) == 1 and networkWeekday(statedNetworkWeekday(today, weekday, true)) == weekday)
```

### Only the authenticated turn may request a state write or relay

The member ID, app, route generation and message ID come from host turn authority. A state write sends the effective state and window. A relay forwards the member's original nonempty text of up to 2,000 code units and the exact active item selected in the turn, or delegates target selection to the service. Repeated operations have the same stable keys and cannot change their request after dispatch.

```quint
type NetworkApp = NtwrkApp | SlopApp | PeonApp | FriendsApp
type NetworkCaller = NetworkHost | NetworkService | NetworkExternal
type MemberTurn = { memberId: str, app: NetworkApp, routeGeneration: int, messageId: str, activeItemIds: List[str], messageUnits: List[int] }
type NetworkAction = SetAvailability({ availability: Availability, window: AvailabilityWindow }) | RelayToActiveItem({ itemId: str, messageUnits: List[int] })
type NetworkPhase = NetworkCold | NetworkReady | NetworkAwaitingReceipt | NetworkComplete
type NetworkOperation = { turn: MemberTurn, operation: NetworkAction, phase: NetworkPhase, result: NetworkOutcome }
type NetworkOutcome = NetworkPending | AvailabilityCommitted({ eventId: str }) | AvailabilityUnchanged | RelayDelivered({ deliveryRequestId: str }) | RelayHeld | RelayBlocked | RelayNotRequested | RelayUnconfirmed
type NetworkEffect = SendNetworkRequest({ turn: MemberTurn, operation: NetworkAction })
type NetworkStep = { state: NetworkOperation, out: List[NetworkEffect] }
pure val sampleTurn: MemberTurn = { memberId: "m1", app: NtwrkApp, routeGeneration: 1, messageId: "msg-1", activeItemIds: List("match"), messageUnits: List(98, 117, 115, 121) }
pure val noAction = RelayToActiveItem({ itemId: "", messageUnits: List() })
pure val initial: NetworkOperation = { turn: { ...sampleTurn, memberId: "", routeGeneration: 0, messageId: "" }, operation: noAction, phase: NetworkCold, result: NetworkPending }
pure val turnValues = Set(sampleTurn, { ...sampleTurn, memberId: "other" }, { ...sampleTurn, routeGeneration: 2 }, { ...sampleTurn, messageId: "" })
pure val availabilityRequestValues = Set({ requested: PausedAvailability, suggested: { begins: -1, ends: 13 }, words: { bodyUnits: sampleTurn.messageUnits, quoteUnits: List(98, 117, 115, 121), quoteOffset: 0, cue: BusyCue, statedWindow: { begins: -1, ends: 12 } }, today: 10 })
pure val itemIdValues = Set("", "match", "missing")
pure def canBindNetworkTurn(s: NetworkOperation, by: NetworkCaller, turn: MemberTurn): bool = by == NetworkHost and s.phase == NetworkCold and turn.memberId != "" and turn.messageId != "" and turn.routeGeneration > 0
pure def bindNetworkTurn(s: NetworkOperation, by: NetworkCaller, turn: MemberTurn): NetworkOperation = { ...s, turn: turn, phase: NetworkReady }
pure def networkRequest(operation: NetworkAction, s: NetworkOperation): NetworkStep = { state: { ...s, operation: operation, phase: NetworkAwaitingReceipt }, out: List(SendNetworkRequest({ turn: s.turn, operation: operation })) }
pure def canSetNetworkAvailability(s: NetworkOperation, by: NetworkCaller, availabilityRequest: AvailabilityRequest): bool = by == NetworkHost and s.phase == NetworkReady and availabilityRequest.words.bodyUnits == s.turn.messageUnits and validNetworkAvailability(availabilityRequest)
pure def setNetworkAvailability(s: NetworkOperation, by: NetworkCaller, availabilityRequest: AvailabilityRequest): NetworkStep = networkRequest(SetAvailability({ availability: effectiveNetworkAvailability(availabilityRequest), window: networkWindow(availabilityRequest) }), s)
pure def canRelayNetwork(s: NetworkOperation, by: NetworkCaller, itemId: str): bool = by == NetworkHost and s.phase == NetworkReady and s.turn.messageUnits.length() > 0 and s.turn.messageUnits.length() <= 2000 and (itemId == "" or s.turn.activeItemIds.includes(itemId))
pure def relayNetwork(s: NetworkOperation, by: NetworkCaller, itemId: str): NetworkStep = networkRequest(RelayToActiveItem({ itemId: itemId, messageUnits: s.turn.messageUnits }), s)
pure def stepNetworkEffectsKeepTurn(before: NetworkOperation, after: NetworkOperation, out: List[NetworkEffect]): bool = out.length() > 0 implies (before.phase == NetworkReady and after.phase == NetworkAwaitingReceipt and after.turn == before.turn and out == List(SendNetworkRequest({ turn: before.turn, operation: after.operation })))
```

### A successful Network action requires its own matching receipt

The adapter accepts a receipt only while its exact turn and action are pending. A changed availability needs its committed event identifier unless the service reports it was unchanged. A moderation hold, rejection, lack of relay intent, or unconfirmed delivery cannot be published as a successful send. A confirmed relay receipt identifies the original request. The same provider message can be observed again without a second request from this operation.

```quint
pure val operationValues = Set(noAction, RelayToActiveItem({ itemId: "match", messageUnits: sampleTurn.messageUnits }), SetAvailability({ availability: BusyAvailability, window: { begins: -1, ends: 12 } }))
pure val resultValues = Set(AvailabilityCommitted({ eventId: "event-1" }), AvailabilityUnchanged, RelayDelivered({ deliveryRequestId: "delivery-1" }), RelayHeld, RelayBlocked, RelayNotRequested, RelayUnconfirmed)
pure def validNetworkReceipt(operation: NetworkAction, result: NetworkOutcome): bool = match operation {
  | SetAvailability(_) => match result { | AvailabilityCommitted(r) => r.eventId != "" | AvailabilityUnchanged => true | _ => false }
  | RelayToActiveItem(_) => match result { | RelayDelivered(r) => r.deliveryRequestId != "" | RelayHeld => true | RelayBlocked => true | RelayNotRequested => true | RelayUnconfirmed => true | _ => false }
}
pure def canObserveNetworkAction(s: NetworkOperation, by: NetworkCaller, turn: MemberTurn, operation: NetworkAction, result: NetworkOutcome): bool = by == NetworkService and s.phase == NetworkAwaitingReceipt and s.turn == turn and s.operation == operation and validNetworkReceipt(operation, result)
pure def observeNetworkAction(s: NetworkOperation, by: NetworkCaller, turn: MemberTurn, operation: NetworkAction, result: NetworkOutcome): NetworkOperation = { ...s, phase: NetworkComplete, result: result }
pure def alwaysNetworkCompleteHasMatchingReceipt(s: NetworkOperation): bool = s.phase == NetworkComplete implies validNetworkReceipt(s.operation, s.result)
pure def sometimesNetworkRelayHeld(s: NetworkOperation): bool = s.phase == NetworkComplete and s.result == RelayHeld
pure val eval_witness_sometimesNetworkRelayHeld = (("bindNetworkTurn", NetworkHost, sampleTurn), ("relayNetwork", NetworkHost, "match"), ("observeNetworkAction", NetworkService, sampleTurn, RelayToActiveItem({ itemId: "match", messageUnits: sampleTurn.messageUnits }), RelayHeld))
```

## Story: See my new Network updates

> As a Network member, I want the service to return newly available updates and acknowledge the same items as seen.

### Only unseen updates for the bound member appear in the read acknowledgement

The storage shell supplies one member-scoped read and acknowledges the selected identifiers in the same operation. Records with another member ID, no update ID or an existing seen flag do not appear in the receipt.

```quint
type NetworkUpdate = { updateId: str, forMember: str, summary: str, seen: bool }
pure def networkUpdatesFor(memberId: str, updates: List[NetworkUpdate]): List[NetworkUpdate] = updates.select(update => update.forMember == memberId and memberId != "" and update.updateId != "" and not(update.seen))
pure val updatesValues = Set(List(), List({ updateId: "new", forMember: "m1", summary: "Update", seen: false }, { updateId: "seen", forMember: "m1", summary: "Read", seen: true }))
pure def lawNetworkUpdatesStayWithMember(memberId: str, updates: List[NetworkUpdate]): bool = networkUpdatesFor(memberId, updates).every(update => update.forMember == memberId and not(update.seen))
```
