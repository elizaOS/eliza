# Mailer

A server that sends messages. It does not send them itself: each transition
returns what the program must do, in order, beside the new state.

## Story: Send a message

### What the mailer does is saving a message and sending it

```quint
type Effect = Saved({ n: int }) | Sent({ n: int })
type Mailer = { sent: int }
type Did = { state: Mailer, out: List[Effect] }

pure val initial: Mailer = { sent: 0 }
```

### At most three messages are sent before a reset

```quint
pure def canSend(m: Mailer, n: int): bool = n > 0 and m.sent < 3
pure def send(m: Mailer, n: int): Did = { state: { sent: m.sent + 1 }, out: List(Saved({ n: n }), Sent({ n: n })) }
pure def reset(m: Mailer): Mailer = { sent: 0 }
pure def alwaysAtMostThree(m: Mailer): bool = 0 <= m.sent and m.sent <= 3
pure def sometimesFull(m: Mailer): bool = m.sent == 3
```

### A message is saved before anything is sent

```quint
pure def isSaved(e: Effect): bool = match e { | Saved(x) => true | _ => false }
pure def stepSavedBeforeSent(before: Mailer, after: Mailer, out: List[Effect]): bool =
  out.foldl(0, (seen, e) => if (seen < 0) seen else if (isSaved(e)) 1 else if (seen == 0) -1 else seen) >= 0
```
