# Hall

Seats booked in a small hall, counted by row and by kind of ticket in tables
keyed by an integer and by a variant.

## Story: Book and cancel seats

### A seat is booked once, and counted by its row and its kind

```quint
type Kind = Adult | Child
type Seat = { row: int, kind: Kind }
type Hall = { booked: List[Seat], byRow: int -> int, byKind: Kind -> int }
pure val initial: Hall = { booked: List(), byRow: Map(), byKind: Map() }
pure val rowValues = Set(1, 2)

pure def canBook(h: Hall, row: int, kind: Kind): bool = h.booked.length() < 3 and not(h.booked.includes({ row: row, kind: kind }))
pure def book(h: Hall, row: int, kind: Kind): Hall =
  { booked: h.booked.append({ row: row, kind: kind }), byRow: h.byRow.put(row, h.byRow.getOr(row, 0) + 1), byKind: h.byKind.put(kind, h.byKind.getOr(kind, 0) + 1) }
```

### The i-th booking can be cancelled

```quint
pure val iValues = Set(0, 1, 2)
pure def canCancel(h: Hall, i: int): bool = 0 <= i and i < h.booked.length()
pure def cancel(h: Hall, i: int): Hall =
  val s = h.booked.nthOr(i, { row: 0, kind: Adult })
  { booked: h.booked.removeAt(i), byRow: h.byRow.put(s.row, h.byRow.getOr(s.row, 0) - 1), byKind: h.byKind.put(s.kind, h.byKind.getOr(s.kind, 0) - 1) }
```

### The hall holds three bookings at most, and every event changes them

```quint
pure def alwaysAtMostThree(h: Hall): bool = h.booked.length() <= 3
pure def stepEveryEventChangesTheBookings(before: Hall, after: Hall): bool = after != before and after.booked != before.booked
pure def sometimesARowIsFull(h: Hall): bool = h.byRow.getOr(1, 0) == 2 and h.byKind.getOr(Child, 0) == 1
```

### Lists are read and changed at an index, whatever the index

```quint
pure def lawOutsideTheListIsTheDefault(xs: List[int], d: int): bool = xs.nthOr(xs.length(), d) == d and xs.nthOr(-1, d) == d
pure def lawRemovingShortensByOne(xs: List[int], i: int): bool =
  xs.removeAt(i).length() == (if (0 <= i and i < xs.length()) xs.length() - 1 else xs.length())
pure def double(n: int): int = n * 2
pure def lawMappingAnAppendedList(xs: List[int], x: int): bool = xs.append(x).listMap(double).length() == xs.length() + 1
```

### A variant literal means the same wherever it stands

```quint
type Ticket = Issued({ row: int }) | Voided
type Desk = { seats: int -> Kind, names: str -> int }
pure val kinds: List[Kind] = List(Adult, Child)
pure val adults: List[Kind] = kinds.select(k => k == Adult)
pure val desk: Desk = { seats: Map(1 -> Adult), names: Map("front" -> 1) }
pure def ticketOf(row: int): Ticket = if (row > 0) Issued({ row: row }) else Voided
pure def named(d: Desk, name: str): int = if (d.names.keys().contains(name)) d.names.get(name) else 0
pure def lastKind(xs: List[Kind]): Kind = xs.foldl(Adult, (acc, x) => x)
pure def seatAt(h: Hall, i: int): Kind = h.booked.nthOr(i, { row: 0, kind: Child }).kind
pure def lawTicketsCompare(row: int): bool = (ticketOf(row) == Voided) == (row <= 0) and (row > 0 implies ticketOf(row) == Issued({ row: row }))
pure def lawTablesHoldVariants(k: Kind, n: int): bool =
  desk.seats.put(2, Child).getOr(2, Adult) == Child and named({ ...desk, names: desk.names.put("back", n) }, "back") == n and kinds.includes(Child) and kinds.includes(k)
pure def lawDefaultsAreVariants(i: int): bool = lastKind(List()) == Adult and seatAt(initial, i) == Child
```
