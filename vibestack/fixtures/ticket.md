# Ticket

A machine whose rule holds because of a law of the library it imports.

## Story: Issue numbers

### Every number issued is above every number before it

```quint
import highest.* from "./highest"
type Desk = { issued: List[int], last: int }
pure val initial: Desk = { issued: List(), last: 0 }
pure def issue(d: Desk): Desk = { val n = highest(d.issued, d.last) + 1 { issued: d.issued.append(n), last: n } }
pure def alwaysTheLastNumberIsNotNegative(d: Desk): bool = d.last >= 0
pure def sometimesTwoIssued(d: Desk): bool = d.issued.length() == 2
```
