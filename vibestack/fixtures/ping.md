# Ping

A client asks a server once, over the network from std/net.md, which loses,
repeats and reorders. The client sends its question again whenever none is
in flight; the server answers the first copy that arrives.

## Story: Ask until answered

### The client has sent one question or none, and the network holds copies of it

```quint
import net as N from "./net"

type Ping = { sent: int, net: List[int], answered: bool }
pure val initial: Ping = { sent: 0, net: List(), answered: false }
pure val iValues = Set(0, 1)
```

### The client asks, and asks again while nothing is in flight

```quint
pure def canAsk(p: Ping): bool = p.sent == 0
pure def ask(p: Ping): Ping = { ...p, sent: 1, net: N::send(p.net, 0) }
pure def canResend(p: Ping): bool = p.sent == 1 and not(p.answered) and p.net.length() == 0
pure def resend(p: Ping): Ping = { ...p, net: N::send(p.net, 0) }
```

### The network loses or repeats a copy, or delivers it

```quint
pure def canLose(p: Ping, i: int): bool = N::has(p.net, i)
pure def lose(p: Ping, i: int): Ping = { ...p, net: N::take(p.net, i) }
pure def canRepeat(p: Ping, i: int): bool = N::has(p.net, i)
pure def repeat(p: Ping, i: int): Ping = { ...p, net: N::repeat(p.net, i) }
pure def canDeliver(p: Ping, i: int): bool = N::has(p.net, i)
pure def deliver(p: Ping, i: int): Ping = { ...p, answered: true, net: N::take(p.net, i) }
```

### Only the question sent is in flight

```quint
pure def alwaysOnlyTheQuestionIsInFlight(p: Ping): bool = N::below(p.net, p.sent)
```

### A question asked is answered

The network delivers a copy that keeps arriving, and the client resends
while nothing is in flight.

```quint
pure def leadsToAnswered(before: Ping, after: Ping): bool = before.sent == 1 implies after.answered
pure val fair_deliver = "strong"
pure val fair_resend = "weak"
```
