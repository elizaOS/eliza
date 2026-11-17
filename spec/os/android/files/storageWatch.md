# Storage watch slot

The files bridge watches the folder on screen with one slot. Each
`storageWatch` call takes a new ticket; the shell then registers the
folder's file observer and media observer for that ticket, or reports a
refusal. `storageUnwatch` and plugin teardown clear the slot. The shell
serializes every event under the slot lock, registers and unregisters the
Android observers, and turns a burst of changes into one `storageChanged`.
The spec holds the ticket and the one registered watch, and decides which
watch is stopped and which callback may publish. Source:
`plugins/plugin-native-filesystem/android/.../browser/StorageBrowser.java`
(`WatchSlot`) and `plugins/plugin-native-filesystem/quint/StorageWatch.qnt`.

## Story: Watch a folder with one live observer

> As the owner, I want the folder I look at to report its changes only from
> its current watch, so that a folder I left never updates my screen and no
> observer is left running.

### Each request takes the next ticket and keeps the registered watch until it is replaced

A new request does not stop the registered watch at once: the previous
folder's observers stay registered until the new ticket installs or is
refused, but they can no longer publish. `Unwatched` holds no observer;
`Refused(t)` holds none because request `t` failed.

```quint
type Slot = Unwatched | Watching({ ticket: int }) | Refused({ ticket: int })
type WatchSlot = { generation: int, slot: Slot }
type WatchEffect = StopWatch({ ticket: int }) | PublishChanged
type WatchStep = { state: WatchSlot, out: List[WatchEffect] }
pure val initial: WatchSlot = { generation: 0, slot: Unwatched }
pure def request(s: WatchSlot): WatchSlot = { ...s, generation: s.generation + 1 }
pure def watchedTicket(slot: Slot): int = match slot { | Watching(w) => w.ticket | _ => 0 }
pure def refusedTicket(slot: Slot): int = match slot { | Refused(r) => r.ticket | _ => 0 }
pure def stopWatched(slot: Slot): List[WatchEffect] =
  if (watchedTicket(slot) > 0) List(StopWatch({ ticket: watchedTicket(slot) })) else List()
pure val ticketValues = Set(0, 1, 2, 3)
```

### Only the newest request can install a watch, and installing stops the previous one

A queued request whose ticket is no longer the newest is refused before
it registers anything. A ticket installs or is refused once.

```quint
pure def hasOutcome(slot: Slot, ticket: int): bool = watchedTicket(slot) == ticket or refusedTicket(slot) == ticket
pure def canInstall(s: WatchSlot, ticket: int): bool = ticket > 0 and ticket == s.generation and not(hasOutcome(s.slot, ticket))
pure def install(s: WatchSlot, ticket: int): WatchStep =
  { state: { ...s, slot: Watching({ ticket: ticket }) }, out: stopWatched(s.slot) }
```

### A refusal of the newest request stops the previous watch and a stale refusal changes nothing

```quint
pure def canRefuse(s: WatchSlot, ticket: int): bool = ticket > 0 and ticket <= s.generation and not(hasOutcome(s.slot, ticket))
pure def refuse(s: WatchSlot, ticket: int): WatchStep =
  if (ticket == s.generation) { state: { ...s, slot: Refused({ ticket: ticket }) }, out: stopWatched(s.slot) }
  else { state: s, out: List() }
pure def stepRefusalKeepsNewestWatch(before: WatchSlot, via: str, after: WatchSlot, out: List[WatchEffect]): bool =
  (via == "refuse" and watchedTicket(before.slot) == before.generation and before.generation > 0)
    implies (after == before and out == List())
```

### Unwatching retires every ticket issued so far and stops the registered watch

```quint
pure def unwatch(s: WatchSlot): WatchStep =
  { state: { generation: s.generation + 1, slot: Unwatched }, out: stopWatched(s.slot) }
```

### Only the watch of the newest ticket publishes a change

A change callback names the ticket its observers were registered for. A
callback of a retired ticket, or one that arrives after its watch was
stopped, publishes nothing.

```quint
pure def observe(s: WatchSlot, ticket: int): WatchStep =
  { state: s, out: if (ticket > 0 and ticket == s.generation and watchedTicket(s.slot) == ticket) List(PublishChanged) else List() }
pure def stepOnlyNewestWatchPublishes(before: WatchSlot, via: str, after: WatchSlot, out: List[WatchEffect]): bool =
  out.includes(PublishChanged) implies (via == "observe" and before.generation > 0 and watchedTicket(before.slot) == before.generation)
```

### A watch is stopped exactly when it leaves the slot

No observer leaks: a step that replaces or removes the registered watch
stops it, and a step stops no other watch.

```quint
pure def stopsOnly(out: List[WatchEffect], ticket: int): bool =
  out.every(e => e == PublishChanged or e == StopWatch({ ticket: ticket }))
pure def stepReplacedWatchIsStopped(before: WatchSlot, via: str, after: WatchSlot, out: List[WatchEffect]): bool = {
  val old = watchedTicket(before.slot)
  val removed = old > 0 and after.slot != before.slot
  stopsOnly(out, old) and (removed iff out.includes(StopWatch({ ticket: old })))
}
```

### The slot names only a ticket that was issued

```quint
pure def slotTicket(slot: Slot): int = match slot { | Watching(w) => w.ticket | Refused(r) => r.ticket | Unwatched => 0 }
pure def alwaysSlotTicketIssued(s: WatchSlot): bool =
  s.generation >= 0 and (s.slot == Unwatched or (slotTicket(s.slot) >= 1 and slotTicket(s.slot) <= s.generation))
```

### A newer watch can replace an older one, a retired watch can wait for its successor, and a request can be refused

```quint
pure def sometimesNewerWatchReplacedOlder(s: WatchSlot): bool = s.generation >= 2 and watchedTicket(s.slot) == s.generation
pure def sometimesRetiredWatchAwaitsSuccessor(s: WatchSlot): bool = watchedTicket(s.slot) > 0 and watchedTicket(s.slot) < s.generation
pure def sometimesNewestRequestRefused(s: WatchSlot): bool = s.generation > 0 and refusedTicket(s.slot) == s.generation
```
