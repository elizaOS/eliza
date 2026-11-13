# Echo

How a hello would be answered by a server, over a network that loses,
repeats and reorders what is sent (`std/net`).
The page has no server yet, so no shell runs this model: `pnpm check`
simulates it and proves it.

## Story: Hear back

> As a visitor, I want my hello answered even over a network that loses,
> repeats and reorders it, without my name ever leaving the page.

### The page keeps the name typed and what it heard, and has sent one hello or none, of which the network holds copies

Only the hello's number goes on the network: the name is the visitor's own.

```quint
import net as N from "./net"

type SecretName = str
type Echo = { name: SecretName, sent: int, net: List[int], heard: str }

pure val initial: Echo = { name: "", sent: 0, net: List(), heard: "" }
pure val iValues = Set(0, 1)
```

### A name can be typed until the hello is sent

```quint
pure def canEnter(e: Echo): bool = e.sent == 0
pure def enter(e: Echo, name: SecretName): Echo = { ...e, name: name }
```

### The page says hello once a name is typed, and again while nothing is in flight and nothing was heard

Of the name, only whether one was typed is let out.

```quint
pure def declassifyTyped(name: SecretName): bool = name != ""
pure def canAsk(e: Echo): bool = e.sent == 0 and declassifyTyped(e.name)
pure def ask(e: Echo): Echo = { ...e, sent: 1, net: N::send(e.net, 0) }
pure def canResend(e: Echo): bool = e.sent == 1 and e.heard == "" and e.net.length() == 0
pure def resend(e: Echo): Echo = { ...e, net: N::send(e.net, 0) }
```

### The server says something to each hello, but what it says is its own

```quint
const reply: (int) => str
pure def lawTheServerSaysSomething(id: int): bool = reply(id) != ""
```

### The network loses or repeats a copy, or delivers it and the page hears the server's answer

The simulator loses a copy three times as often as it does anything else, so
that hellos are often sent again.

```quint
pure def canLose(e: Echo, i: int): bool = N::has(e.net, i)
pure def lose(e: Echo, i: int): Echo = { ...e, net: N::take(e.net, i) }
pure def canRepeat(e: Echo, i: int): bool = N::has(e.net, i)
pure def repeat(e: Echo, i: int): Echo = { ...e, net: N::repeat(e.net, i) }
pure def canDeliver(e: Echo, i: int): bool = N::has(e.net, i)
pure def deliver(e: Echo, i: int): Echo = { ...e, heard: reply(N::at(e.net, i)), net: N::take(e.net, i) }
pure val weight_lose = 3
```

### Only the hello sent is in flight

```quint
pure def alwaysOnlyTheHelloIsInFlight(e: Echo): bool = N::below(e.net, e.sent)
```

### A hello sent is answered

The network delivers a copy that keeps arriving, and the page sends its
hello again while nothing is in flight.

```quint
pure def leadsToHeard(e: Echo, later: Echo): bool = e.sent == 1 implies later.heard != ""
pure val fair_deliver = "strong"
pure val fair_resend = "weak"
```

### The page can hear back

```quint
pure def sometimesHeard(e: Echo): bool = e.heard != ""
```
