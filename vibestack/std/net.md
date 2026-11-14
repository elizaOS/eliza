# Network

A network between the parts of a system that may lose, repeat and reorder
what is sent. It ships with the tools: a spec imports it under a name,
`import net as N from "./net"`, keeps the messages it sends in a list of its
own, and puts their positions in that list on the network. Its events then
take a message off the network, at any position, to deliver it or to lose
it, and repeat one.

## Messages in flight

### The network holds the numbers of the messages in flight, oldest first

A message is sent by appending its number. Any message in flight can be the
next to arrive, so the network reorders; taking only the one at position 0
makes it a queue.

```quint
pure def send(flight: List[int], id: int): List[int] = flight.append(id)
pure def has(flight: List[int], i: int): bool = 0 <= i and i < flight.length()
pure def at(flight: List[int], i: int): int = if (has(flight, i)) flight.nth(i) else -1
```

### A message taken off the network is delivered or lost

Taking it removes that one copy and keeps the others in their order.

```quint
type Cut = { kept: List[int], k: int }
pure def take(flight: List[int], i: int): List[int] =
  flight.foldl({ kept: List(), k: 0 }, (c, id) => { kept: if (c.k == i) c.kept else c.kept.append(id), k: c.k + 1 }).kept
```

### A message in flight can be repeated

```quint
pure def repeat(flight: List[int], i: int): List[int] = if (has(flight, i)) flight.append(flight.nth(i)) else flight
```

## What a system can rely on

### Only messages that were sent are in flight

A system that numbers its messages from 0 states this of its network as an
`always` rule, `N::below(s.net, s.sent.length())`, and proves its transitions
keep it with these laws: a proof file calls `net_lawTakingStaysBelow_ensures(…)`
and the others as it would a law of any spec it imports.

```quint
pure def below(flight: List[int], n: int): bool = flight.every(id => 0 <= id and id < n)
pure def lawABoundCanGrow(flight: List[int], n: int): bool =
  below(flight, n) implies below(flight, n + 1)
pure def lawSendingStaysBelow(flight: List[int], id: int, n: int): bool =
  (below(flight, n) and 0 <= id and id < n) implies below(send(flight, id), n)
pure def lawTakingStaysBelow(flight: List[int], i: int, n: int): bool =
  below(flight, n) implies below(take(flight, i), n)
pure def lawRepeatingStaysBelow(flight: List[int], i: int, n: int): bool =
  below(flight, n) implies below(repeat(flight, i), n)
pure def lawWhatIsAtAPositionIsBelow(flight: List[int], i: int, n: int): bool =
  (below(flight, n) and has(flight, i)) implies (0 <= at(flight, i) and at(flight, i) < n)
```

### Taking a message leaves one fewer in flight

```quint
pure def lawTakingRemovesOne(flight: List[int], i: int): bool =
  has(flight, i) implies take(flight, i).length() == flight.length() - 1
```
