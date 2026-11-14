# Alpha browser calendar agenda source observation

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` calls
`calendarAgendaObservation` in `apps/app/src/runtime/connection-ui.tsx`
before dispatching a chat turn. The caller imports
`@elizaos/core/read-memo` at `c518127a025ab173874af9c7d304f26b25213b0d`.
[Calendar data](./calendarAvailabilityData.md) owns the separate
availability result. [Core memo behavior](../../core/memo.md) owns
shared promise retention and rejection cleanup.

## Story: Give the current chat only the selected local calendar identity

### Only an eligible captured local selection can start the peek or read

The current connection must offer the calendar agenda capability, and
the captured Calendar view must be explicitly nonsensitive. Native
contexts and other views do not use this browser read. A source
selection supplies its own ID and revision and repeats them in its
account and source fields. An event selection supplies a valid event
identity and its linked source. Runtime decoders validate these
shapes. The observed source must be the browser adapter's `local`
source. Canonical, retained and unknown IDs cannot initialize the
local document through this path.

```quint
type CalendarSelection = SelectSource | SelectEvent | SelectOther
type AgendaRequest = { native: bool, supportsAgenda: bool, calendarView: bool, explicitPublic: bool,
  selection: CalendarSelection, decoded: bool, matchingSourceFields: bool, sourceId: str, sourceRevision: str }
pure def mayObserveAgenda(request: AgendaRequest): bool =
  not(request.native) and request.supportsAgenda and request.calendarView and request.explicitPublic and request.decoded and
    request.sourceId == "local" and request.sourceRevision != "" and
    (request.selection == SelectEvent or (request.selection == SelectSource and request.matchingSourceFields))
pure val approvedAgenda: AgendaRequest = { native: false, supportsAgenda: true, calendarView: true, explicitPublic: true,
  selection: SelectSource, decoded: true, matchingSourceFields: true, sourceId: "local", sourceRevision: "saved" }
pure val requestValues = Set(approvedAgenda, { ...approvedAgenda, sourceId: "remote" }, { ...approvedAgenda, explicitPublic: false },
  { ...approvedAgenda, matchingSourceFields: false }, { ...approvedAgenda, selection: SelectEvent, matchingSourceFields: false })
pure def lawPrivateOrRemoteCannotStart(request: AgendaRequest): bool =
  (not(request.explicitPublic) or request.sourceId != "local" or request.native) implies not(mayObserveAgenda(request))
pure def lawCalendarSourceMustRepeatItsIdentity(request: AgendaRequest): bool =
  (request.selection == SelectSource and not(request.matchingSourceFields)) implies not(mayObserveAgenda(request))
```

### Sharing a promise leaves every caller responsible for current readback

The memo is private to the exact `DeviceActions` object, with one
entry and an infinite TTL. Its key has the current source epoch,
source ID and revision. A local source update or a cross-screen
calendar document change advances the epoch. A matching reader
shares the same promise, and a different key displaces the entry.
The exact source pin uses a monotonic TTL clock. Grace's pin uses
wall time for the general memo, but its product does not use this
infinite-TTL Calendar observation.

The initiating caller checks that it is current before acquiring
the read and again inside the asynchronous producer. Each subscriber
rechecks its own caller and the captured source epoch after awaiting.
The decoded result must exactly match the requested source and
revision. Success contributes only `sourceId` and `sourceRevision`,
with no calendar contents added by this observation. A rejected
promise is omitted and can be retried after its matching cache entry
is removed. The outer chat caller independently rechecks its abort
signal and current binding before dispatch. The host supplies object
identity, promise settlement, and current caller observations.

```quint
type AgendaKey = { actionsIdentity: int, sourceEpoch: int, sourceId: str, sourceRevision: str }
type AgendaReply = { successful: bool, sourceId: str, sourceRevision: str }
pure def sharesAgendaPromise(captured: AgendaKey, resident: AgendaKey): bool =
  captured.actionsIdentity == resident.actionsIdentity and captured.sourceEpoch == resident.sourceEpoch and
    captured.sourceId == resident.sourceId and captured.sourceRevision == resident.sourceRevision
pure def admitsAgendaReply(captured: AgendaKey, nowEpoch: int, currentCaller: bool, reply: AgendaReply): bool =
  currentCaller and captured.sourceEpoch == nowEpoch and reply.successful and
    captured.sourceId == reply.sourceId and captured.sourceRevision == reply.sourceRevision
pure val savedAgendaKey: AgendaKey = { actionsIdentity: 1, sourceEpoch: 0, sourceId: "local", sourceRevision: "saved" }
pure val capturedValues = Set(savedAgendaKey, { ...savedAgendaKey, actionsIdentity: 2 }, { ...savedAgendaKey, sourceEpoch: 1 })
pure val residentValues = capturedValues
pure val nowEpochValues = Set(0, 1, 2)
pure val replyValues = Set({ successful: true, sourceId: "local", sourceRevision: "saved" },
  { successful: true, sourceId: "local", sourceRevision: "different" },
  { successful: false, sourceId: "local", sourceRevision: "saved" })
pure def lawDistinctActionsNeverShare(captured: AgendaKey, resident: AgendaKey): bool =
  captured.actionsIdentity != resident.actionsIdentity implies not(sharesAgendaPromise(captured, resident))
pure def lawChangedEpochCannotPublish(captured: AgendaKey, nowEpoch: int, currentCaller: bool, reply: AgendaReply): bool =
  captured.sourceEpoch != nowEpoch implies not(admitsAgendaReply(captured, nowEpoch, currentCaller, reply))
pure def lawChangedRevisionCannotPublish(captured: AgendaKey, nowEpoch: int, currentCaller: bool, reply: AgendaReply): bool =
  captured.sourceRevision != reply.sourceRevision implies not(admitsAgendaReply(captured, nowEpoch, currentCaller, reply))
```
