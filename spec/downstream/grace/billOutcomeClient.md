# Latest bill outcome lookup

## Story: Keep the current bill visible through out-of-order lookups

### Only the latest lookup may publish an admitted task ID

Grace instantiates `LatestOutcomeController` from the pinned
`plugins/plugin-personal-assistant/native-host/bill-review-controller.ts`.
An asynchronous lookup has a ticket. Starting another lookup or canceling
increments the ticket. A current successful response may provide a
validated task ID, or no identifier when none passes admission. A current
failure propagates an error without replacing the current identifier.
A canceled generation has no open request. Late completions and errors stay silent. The wire task ID admits 1–256
ASCII characters and excludes slash.

```quint
type OutcomeReply = { id: str, idValidated: bool, failed: bool }
type LookupSignal = NoLookupSignal | LookupReceived | LookupError
type LatestLookup = { generation: int, requestTicket: int, visibleId: str, notice: LookupSignal, replyTicket: int }
pure val noLookupNotice: LookupSignal = NoLookupSignal
pure val receivedLookupNotice: LookupSignal = LookupReceived
pure val errorLookupNotice: LookupSignal = LookupError
pure val initial: LatestLookup = { generation: 0, requestTicket: 0, visibleId: "", notice: noLookupNotice, replyTicket: 0 }
pure def startLookup(client: LatestLookup): LatestLookup =
  { ...client, generation: client.generation + 1, requestTicket: client.generation + 1, notice: noLookupNotice }
pure def cancelLookup(client: LatestLookup): LatestLookup =
  { ...client, generation: client.generation + 1, requestTicket: 0, notice: noLookupNotice }
pure def canFinishLookup(client: LatestLookup, ticket: int): bool =
  ticket > 0 and ticket <= client.generation
pure def finishLookup(client: LatestLookup, ticket: int, reply: OutcomeReply): LatestLookup =
  if (ticket != client.generation or ticket != client.requestTicket) client
  else if (reply.failed) { ...client, requestTicket: 0, notice: errorLookupNotice, replyTicket: ticket }
  else { ...client, visibleId: if (reply.idValidated) reply.id else "", requestTicket: 0, notice: receivedLookupNotice, replyTicket: ticket }
pure def alwaysNoticesAreCurrent(client: LatestLookup): bool =
  client.notice != noLookupNotice implies client.replyTicket == client.generation
pure def alwaysLiveRequestBelongsToCurrentGeneration(client: LatestLookup): bool =
  client.requestTicket == 0 or client.requestTicket == client.generation
pure def stepStaleOrFailedReadKeepsVisibleId(before: LatestLookup, after: LatestLookup): bool =
  (after.generation != before.generation or after.notice == errorLookupNotice) implies after.visibleId == before.visibleId
pure def lawStaleCompletionIsSilent(client: LatestLookup, ticket: int, reply: OutcomeReply): bool =
  (ticket != client.generation or ticket != client.requestTicket) implies finishLookup(client, ticket, reply) == client
pure def sometimesLookupPublishesId(client: LatestLookup): bool =
  client.notice == receivedLookupNotice and client.visibleId != ""
pure def sometimesLookupKeepsIdAfterError(client: LatestLookup): bool =
  client.notice == errorLookupNotice and client.visibleId != ""
pure val clientValues = Set(initial, { ...initial, generation: 1, visibleId: "taskA" })
pure val ticketValues = Set(1, 2, 3)
pure val replyValues = Set({ id: "taskA", idValidated: true, failed: false },
  { id: "", idValidated: false, failed: false }, { id: "", idValidated: false, failed: true })
```
