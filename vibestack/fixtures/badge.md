# Badge

## Story: Issue a badge

> As a guard, I want each badge to carry a one-digit code made from its
> holder's name, so that I can check it at a glance.

### A badge's code is made from a name, and is one digit

How the code is made is not modelled: only that it is a digit.

```quint
const code: (str) => int
pure def lawCodeIsADigit(name: str): bool = 0 <= code(name) and code(name) <= 9
```

### Issuing a badge records its code

```quint
type Desk = { last: int, issued: int }
pure val initial: Desk = { last: 0, issued: 0 }
pure def issue(d: Desk, name: str): Desk = { last: code(name), issued: d.issued + 1 }
pure def sometimesIssued(d: Desk): bool = d.issued > 0
```

### The last code issued is a digit

```quint
pure def alwaysTheLastCodeIsADigit(d: Desk): bool = 0 <= d.last and d.last <= 9
```
