# Alpha authenticated client observation and optional calendar day

Alpha imports Eliza's `packages/contracts/src/client-turn-observation.ts`
and the instance ID validator from `contracts/remote-agent-pairing.ts`.
`runtime/client-observation-support.ts` learns support in a verified
session and compares it again before use. [Remote pairing](../remotePairing.md)
owns parsing and mint; [conversation](../conversation.md) owns dispatch
and the current turn. The pinned Alpha model `ClientObservationSupport`
and cases in `ObservationTurnDispatch` and `CommittedViewObservation`
expose separate learn, compare and cancellation edges.

## Story: Share screen context with my current peer only when its process has advertised support

### Validation and negotiation do not create search or effect authority

The v1 peer support object admits exactly version and optionalFields;
optionalFields is empty or contains the single literal calendarDay.
The peer status instance is a canonical lowercased UUID (versions
1–8 with RFC variant), learned from the authenticated status response
for one origin, owner, agent, session and connection epoch. A malformed,
legacy, revoked or unavailable peer receives all ordinary context and
no calendarDay. No later process instance is learned under a successfully
settled session. A new verified connection gets independent negotiation.
A cancelled learn can retry under a live caller; an aborted waiting
call does not cancel a background read owned by another caller.
A format preference is capability information; it neither binds
source data nor authorizes any effect.

CalendarDay contains exactly a real Gregorian date (year at least 1970)
and an admitted IANA time zone. Its authoring context must be the current
nonsensitive Calendar view. The ordinary observation codec checks its
exact fields and identifier and size bounds, rejects controls and
unknown fields, and cannot transmit selected objects from sensitive
views. Invalid observation data fails closed without truncation; this
model tracks capability evidence rather than its string parser.

```quint
type ObservationView = CalendarView | OtherView
pure def admitsCalendarDay(view: ObservationView, sensitive: bool, validDate: bool, validZone: bool): bool =
  view == CalendarView and not(sensitive) and validDate and validZone
pure def lawSensitiveNeverOffersCalendarDay(view: ObservationView, validDate: bool, validZone: bool): bool =
  not(admitsCalendarDay(view, true, validDate, validZone))
```

### A new status comparison is required for each optional turn

Pending reads carry tickets. A turn can join a current learn or begin one
if needed. A positive learn never sends the field by itself. Each turn
presenting an optional calendar day compares a fresh response for the
original server instance and exact current binding. A mismatch drops
the old capability, leaves ordinary context unchanged, and cannot
relearn under this session. Losing the session or cancelling fences
the unfinished turn; a cancelled optional compare retires its claim.
A turn that has already admitted a field must have completed its learn;
this proof fact rules out a subsequent late learn replacing its identity.
This reducer abstracts one authenticated binding and one current turn;
the host separately validates the enclosing origin, owner, agent,
session and epoch on every completion.

```quint
type LearnState = LearnIdle | Learning | Learned
type TurnState = NoTurn | Waiting | Comparing | Ordinary | Admitted | Cancelled
type PeerStatus = { instance: int, authenticated: bool, supports: bool }
type Negotiation = { live: bool, learner: LearnState, instance: int, turn: TurnState, ticket: int, turnId: int, compared: bool }
pure val initial: Negotiation = { live: true, learner: LearnIdle, instance: 0, turn: NoTurn, ticket: 0, turnId: 0, compared: false }
pure def pendingTurn(s: Negotiation): bool = s.turn == Waiting or s.turn == Comparing
pure def validPeer(status: PeerStatus): bool = status.instance > 0 and status.authenticated and status.supports
pure def canBeginLearn(s: Negotiation): bool = s.live and s.learner == LearnIdle
pure def beginLearn(s: Negotiation): Negotiation = { ...s, learner: Learning, ticket: s.ticket + 1 }
pure def canAbortLearn(s: Negotiation, learnId: int): bool = s.live and s.learner == Learning and learnId == s.ticket
pure def abortLearn(s: Negotiation, learnId: int): Negotiation =
  if (s.turn == Waiting) { ...s, ticket: s.ticket + 1 } else { ...s, learner: LearnIdle }
pure def canSettleLearn(s: Negotiation, learnId: int, status: PeerStatus): bool =
  s.live and s.learner == Learning and learnId == s.ticket
pure def settleLearn(s: Negotiation, learnId: int, status: PeerStatus): Negotiation =
  { ...s, learner: Learned, instance: if (validPeer(status)) status.instance else 0,
     turn: if (s.turn != Waiting) s.turn else if (validPeer(status)) Comparing else Ordinary }
pure def canStartTurn(s: Negotiation, offered: bool): bool = s.live and not(pendingTurn(s))
pure def startTurn(s: Negotiation, offered: bool): Negotiation = {
  val needsLearn = offered and s.learner == LearnIdle
  { ...s, learner: if (needsLearn) Learning else s.learner, ticket: s.ticket + (if (needsLearn) 1 else 0),
    turnId: s.turnId + 1, compared: false,
    turn: if (not(offered)) Ordinary else if (s.learner != Learned) Waiting else if (s.instance > 0) Comparing else Ordinary }
}
pure def canComparePeer(s: Negotiation, currentTurn: int, status: PeerStatus): bool = s.live and s.turn == Comparing and currentTurn == s.turnId
pure def comparePeer(s: Negotiation, currentTurn: int, status: PeerStatus): Negotiation = {
  val admits = s.instance > 0 and validPeer(status) and status.instance == s.instance
  { ...s, instance: if (admits) s.instance else 0, turn: if (admits) Admitted else Ordinary, compared: admits }
}
pure def canAbortTurn(s: Negotiation, currentTurn: int): bool = s.live and pendingTurn(s) and currentTurn == s.turnId
pure def abortTurn(s: Negotiation, currentTurn: int): Negotiation =
  { ...s, instance: if (s.turn == Comparing) 0 else s.instance, turn: Cancelled, compared: false }
pure def canRetireBinding(s: Negotiation): bool = s.live
pure def retireBinding(s: Negotiation): Negotiation = { ...s, live: false, instance: 0, turn: Cancelled, compared: false }
pure def alwaysAdmittedHasComparison(s: Negotiation): bool = s.turn == Admitted implies s.live and s.compared and s.instance > 0 and s.learner == Learned
pure def alwaysRetiredNeverRetainsPeer(s: Negotiation): bool = not(s.live) implies s.instance == 0 and s.turn == Cancelled
pure def alwaysComparingUsesLearnedInstance(s: Negotiation): bool = s.turn == Comparing implies s.learner == Learned and s.instance > 0
pure def alwaysWaitingHasLearn(s: Negotiation): bool = s.turn == Waiting implies s.learner == Learning
pure def alwaysNonnegativeTickets(s: Negotiation): bool = s.ticket >= 0 and s.turnId >= 0
pure def stepClearedPeerCannotBeRelearned(before: Negotiation, via: str, after: Negotiation): bool =
  before.learner == Learned implies after.learner == Learned and (before.instance == 0 implies after.instance == 0)
pure def lawDifferentInstancePreventsOptional(s: Negotiation, currentTurn: int, status: PeerStatus): bool =
  status.instance != s.instance implies comparePeer(s, currentTurn, status).turn != Admitted
pure def sometimesPeerCompared(s: Negotiation): bool = s.turn == Admitted
pure def sometimesPriorSupportRetired(s: Negotiation): bool = s.live and s.learner == Learned and s.instance == 0 and s.turn == Ordinary
pure val learnIdValues = Set(1, 2, 3, 4)
pure val currentTurnValues = Set(1, 2, 3, 4)
pure val statusValues = Set(
  { instance: 1, authenticated: true, supports: true },
  { instance: 2, authenticated: true, supports: true },
  { instance: 1, authenticated: true, supports: false },
  { instance: 0, authenticated: false, supports: false }
)
pure val weight_startTurn = 5
pure val weight_settleLearn = 6
pure val weight_comparePeer = 6
```
