# Tally

A count of greetings and nothing else. The greeter of [the app](./index.md)
refines it, so every rule here holds of the greeter's count.

## Story: Count greetings

> As a visitor, I want every greeting counted, one at a time.

### A tally starts at zero and counts one greeting at a time

```quint
type Tally = { greetings: int }

pure val initial: Tally = { greetings: 0 }

pure def greet(t: Tally): Tally = { greetings: t.greetings + 1 }
```

### A tally is never below zero

```quint
pure def alwaysNeverBelowZero(t: Tally): bool = t.greetings >= 0
```
