# Office

A machine that keeps the rule of a machine it imports, which only a proof file
proves there: the office's proof calls what the ticket's unit proved (see
selftest).

## Story: Serve customers

### An office has a desk, and serving issues a ticket there

```quint
import ticket as T from "./ticket"

type Office = { desk: T::Desk, served: int }

pure val initial: Office = { desk: T::initial, served: 0 }

pure def serve(o: Office): Office = { desk: T::issue(o.desk), served: o.served + 1 }

pure def alwaysTheDeskKeepsItsRule(o: Office): bool = T::alwaysTheLastNumberIsNotNegative(o.desk)

pure def sometimesServedTwice(o: Office): bool = o.served == 2
```
