# Browser sign-in return

A registered application (a *client*: a consumer's renderer with its own
callback binding) can start a browser sign-in. Its browser keeps the exact
callback binding, the live state and a one-use pending record in session
storage, and the return delivers the result to that client only. Several
clients on one device sign in independently. When the return lands in a
different Android process, [return adoption](./android/returnAdoption.md)
decides whether it may still complete.

## Story: Complete a browser sign-in only for the client that started it

> As a person signing in through the browser, I want the result to reach
> the app screen that asked for it, once, and never another app's screen.

### Only a registered client with a valid origin and proof starts a browser sign-in

Protected registration selects the client. A start from an unregistered
client, or without a valid origin and proof key, records nothing. A client
has at most one browser attempt.

```quint
type BrowserReturns = { registered: Set[int], started: Set[int], pending: Set[int], expired: Set[int], delivered: List[int], misdelivered: bool }
pure val initial: BrowserReturns = { registered: Set(), started: Set(), pending: Set(), expired: Set(), delivered: List(), misdelivered: false }
pure def canRegister(b: BrowserReturns, client: int): bool = not(b.registered.contains(client))
pure def register(b: BrowserReturns, client: int): BrowserReturns = { ...b, registered: b.registered.union(Set(client)) }
pure def canStart(b: BrowserReturns, client: int): bool = not(b.started.contains(client))
pure def start(b: BrowserReturns, client: int, validOriginAndProof: bool): BrowserReturns =
  if (b.registered.contains(client) and validOriginAndProof)
    { ...b, started: b.started.union(Set(client)), pending: b.pending.union(Set(client)) }
  else b
pure val clientValues = Set(1, 2)
pure def alwaysStartedClientsAreRegistered(b: BrowserReturns): bool = b.started.subseteq(b.registered) and b.pending.subseteq(b.started)
pure def sometimesTwoClientsPending(b: BrowserReturns): bool = b.pending.size() == 2
```

### A return is delivered once, to the bound client, while its record is live

A callback is admitted only for a registered client with a pending record,
when the callback's bound client is that client, its state matches, its
shape is valid and the record has not expired (ten minutes). Admission
consumes the record, so a repeated callback finds nothing. A refused
callback changes nothing.

```quint
pure def callbackAdmitted(b: BrowserReturns, client: int, boundClient: int, matchingState: bool, validShape: bool): bool =
  b.registered.contains(client) and b.pending.contains(client) and not(b.expired.contains(client)) and
    client == boundClient and matchingState and validShape
pure def callback(b: BrowserReturns, client: int, boundClient: int, matchingState: bool, validShape: bool): BrowserReturns =
  if (callbackAdmitted(b, client, boundClient, matchingState, validShape))
    { ...b, pending: b.pending.exclude(Set(client)), delivered: b.delivered.append(client), misdelivered: b.misdelivered or client != boundClient }
  else b
pure def canExpire(b: BrowserReturns, client: int): bool = b.pending.contains(client) and not(b.expired.contains(client))
pure def expire(b: BrowserReturns, client: int): BrowserReturns = { ...b, expired: b.expired.union(Set(client)) }
pure val boundClientValues = Set(1, 2)
pure def deliveries(b: BrowserReturns, client: int): int = b.delivered.select(c => c == client).length()
pure def alwaysExactLiveClient(b: BrowserReturns): bool =
  not(b.misdelivered) and b.delivered.select(c => not(b.registered.contains(c))).length() == 0
pure def alwaysConsumedOnce(b: BrowserReturns): bool =
  b.registered.forall(c => deliveries(b, c) <= 1 and (deliveries(b, c) == 1 implies not(b.pending.contains(c))))
pure def alwaysIndependentClients(b: BrowserReturns): bool =
  b.started.forall(c => (deliveries(b, c) == 0) iff b.pending.contains(c))
pure def sometimesReturnDelivered(b: BrowserReturns): bool = b.delivered.length() > 0
pure def sometimesExpiredRecordWaits(b: BrowserReturns): bool = b.expired.size() > 0 and b.pending.size() > 0
```
