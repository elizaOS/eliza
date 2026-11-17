# Keyset paging over provider rows

The paging every Android record reader shares: contacts, the call log and the
media catalog. A query's rows have one total order; a page is the first rows
after its start, up to its limit; a cursor names the exact query and the last
row returned. Each reader keeps its own limits, filters, snapshots and cursor
storage and imports this library as `Pg`. The provider query, its selection
arguments and the cursor encoding stay in the shell.

## Story: Page my records without repeats or gaps

> As the person, I want to read my contacts, calls and photos a page at a
> time, so that no record appears twice and none is left out.

### Rows of one query follow one total order that ends in the row ID

A row key holds the sort coordinates of its query, oriented by the shell so
that page order is ascending, with the provider row ID last: contacts use
their position and ID, the call log `-date` and `-ID`, the media catalog
`-captureTime`, the volume ordinal and `-ID`. Two rows with the same key are
the same row.

```quint
type RowKey = { major: int, minor: int, rowId: int }
pure val noRow: RowKey = { major: 0, minor: 0, rowId: 0 }
pure def precedes(x: RowKey, y: RowKey): bool =
  x.major < y.major or (x.major == y.major and (x.minor < y.minor or (x.minor == y.minor and x.rowId < y.rowId)))
pure val keyValues = Set({ major: 0, minor: 0, rowId: 1 }, { major: 0, minor: 0, rowId: 2 }, { major: 0, minor: 1, rowId: 1 }, { major: 1, minor: 0, rowId: 0 })
pure val xValues = keyValues
pure val yValues = keyValues
pure val zValues = keyValues
pure def lawNoRowPrecedesItself(x: RowKey): bool = not(precedes(x, x))
pure def lawDistinctRowsAreOrderedOneWay(x: RowKey, y: RowKey): bool = x != y implies (precedes(x, y) != precedes(y, x))
pure def lawOrderIsTransitive(x: RowKey, y: RowKey, z: RowKey): bool = (precedes(x, y) and precedes(y, z)) implies precedes(x, z)
```

### A page holds the first rows after its start, in order, up to its limit

The provider returns rows in page order. A refused start reads no row.

```quint
type CursorRefusal = OtherQuery | MovedBoundary
type PageStart = FromFirst | AfterRow({ last: RowKey }) | Refused({ reason: CursorRefusal })
type OrderScan = { ordered: bool, seen: bool, previous: RowKey }
type PagePrefix = { count: int, kept: List[RowKey] }
pure def inPageOrder(rows: List[RowKey]): bool =
  rows.foldl({ ordered: true, seen: false, previous: noRow }, (scan, key) =>
    { ordered: scan.ordered and (not(scan.seen) or precedes(scan.previous, key)), seen: true, previous: key }).ordered
pure def isAfterStart(start: PageStart, key: RowKey): bool = match start {
  | FromFirst => true
  | AfterRow(a) => precedes(a.last, key)
  | Refused(_) => false
}
pure def eligibleRows(rows: List[RowKey], start: PageStart): List[RowKey] = rows.select(key => isAfterStart(start, key))
pure def takePage(rows: List[RowKey], start: PageStart, limit: int): List[RowKey] =
  eligibleRows(rows, start).foldl({ count: 0, kept: List() }, (prefix, key) =>
    if (prefix.count < limit) { count: prefix.count + 1, kept: prefix.kept.append(key) } else prefix).kept
pure val rowsValues = Set(List(), List({ major: 0, minor: 0, rowId: 1 }),
  List({ major: 0, minor: 0, rowId: 1 }, { major: 0, minor: 0, rowId: 2 }, { major: 0, minor: 1, rowId: 1 }),
  List({ major: 0, minor: 0, rowId: 2 }, { major: 0, minor: 1, rowId: 1 }, { major: 1, minor: 0, rowId: 0 }),
  List({ major: 1, minor: 0, rowId: 0 }, { major: 0, minor: 0, rowId: 1 }))
pure val startValues = Set(FromFirst, AfterRow({ last: { major: 0, minor: 0, rowId: 1 } }),
  AfterRow({ last: { major: 0, minor: 1, rowId: 1 } }), Refused({ reason: OtherQuery }))
pure val limitValues = Set(0, 1, 2, 3)
pure def lawPageStaysAfterItsStartWithinItsLimit(rows: List[RowKey], start: PageStart, limit: int): bool = {
  val page = takePage(rows, start, limit)
  page.every(key => isAfterStart(start, key)) and (limit >= 0 implies page.length() <= limit)
}
```

### A next cursor is offered exactly when rows remain after the page

The shell reads one lookahead row beyond the limit; that row is never on the
page. The cursor names the query and the page's last row.

```quint
type PageCursor = { query: str, last: RowKey }
type PageEnd = MoreAfter({ following: PageCursor }) | EndOfRows
pure def pageEnd(query: str, rows: List[RowKey], start: PageStart, limit: int): PageEnd = {
  val page = takePage(rows, start, limit)
  if (limit >= 1 and eligibleRows(rows, start).length() > limit)
    MoreAfter({ following: { query: query, last: page.nthOr(limit - 1, noRow) } })
  else EndOfRows
}
pure val queryValues = Set("", "ann", "bob")
pure def lawCursorExactlyWhenRowsRemain(query: str, rows: List[RowKey], start: PageStart, limit: int): bool = {
  val e = pageEnd(query, rows, start, limit)
  (inPageOrder(rows) and limit >= 1) implies match e {
    | MoreAfter(m) => m.following.query == query and takePage(rows, AfterRow({ last: m.following.last }), limit).length() > 0
    | EndOfRows => takePage(rows, start, limit).length() == eligibleRows(rows, start).length()
  }
}
```

### The next page neither repeats the last row nor skips one

Two consecutive pages are exactly the first two limits of rows after the
first page's start.

```quint
pure def lawConsecutivePagesNeitherRepeatNorSkip(query: str, rows: List[RowKey], start: PageStart, limit: int): bool = {
  val e = pageEnd(query, rows, start, limit)
  (inPageOrder(rows) and limit >= 1) implies match e {
    | MoreAfter(m) => takePage(rows, start, limit).concat(takePage(rows, AfterRow({ last: m.following.last }), limit)) == takePage(rows, start, limit * 2)
      and not(takePage(rows, AfterRow({ last: m.following.last }), limit).includes(m.following.last))
    | EndOfRows => true
  }
}
```

### A page continues only from its exact query and last row key

The shell answers whether the provider's row at the cursor's boundary still
has the cursor's last key (contacts check the row at the saved position; a
keyset reader whose key is the boundary answers true). A cursor whose
boundary moved is refused, never skipped past or repeated.

```quint
type PageRequest = FirstRequest | ContinueRequest({ resume: PageCursor })
pure def startOf(request: PageRequest, query: str, boundaryHolds: bool): PageStart = match request {
  | FirstRequest => FromFirst
  | ContinueRequest(c) =>
    if (c.resume.query != query) Refused({ reason: OtherQuery })
    else if (not(boundaryHolds)) Refused({ reason: MovedBoundary })
    else AfterRow({ last: c.resume.last })
}
pure val cursorValues = Set({ query: "ann", last: { major: 0, minor: 0, rowId: 1 } }, { query: "bob", last: { major: 0, minor: 1, rowId: 1 } })
pure def lawContinuesOnlyItsQueryAndBoundary(cursor: PageCursor, query: str, boundaryHolds: bool): bool =
  (startOf(ContinueRequest({ resume: cursor }), query, boundaryHolds) == AfterRow({ last: cursor.last })) iff (cursor.query == query and boundaryHolds)
```

### A changed query never continues an old cursor and starts from the first page

A cursor from another query is refused as `OtherQuery`, whatever its boundary;
the reader reports it, and the next read of the new query is a first request.

```quint
pure def lawChangedQueryStartsOver(cursor: PageCursor, query: str, boundaryHolds: bool): bool =
  cursor.query != query implies
    (startOf(ContinueRequest({ resume: cursor }), query, boundaryHolds) == Refused({ reason: OtherQuery })
      and startOf(FirstRequest, query, boundaryHolds) == FromFirst)
```
