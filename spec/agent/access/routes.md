# Route gate

The route list a product hands the device, and the gate that admits a
request against it before any I/O. A list is a set of groups; each group
claims the paths under its prefixes and lists the routes it serves. os
imports this spec for its native bridge and for the cloud requests of its
sign-in plugin; its Java gate and the agent's TypeScript gate are both
checked against it by `driver:agent__access__routes`. Each caller kind
(renderer, native) has its own `RouteGate` loaded from its own list; an
importer that holds a list itself calls `admission(list, request)`. Which
caller may call at all is local access, `access/auth.md`.

The shell decodes the wire form before the gate sees it. A literal is
`[A-Za-z0-9._-]+`, never made only of dots, and a method is one of the five
below, or the list is refused by its schema. A flat list (a bare array of
routes) is one group with the empty prefix whose id is `flatParam`. Flaws
are found in the raw, undecoded request text: a `\`, a fragment (`#`), a
character from the unsafe set (U+0000-U+001F, U+007F, space, U+00A0,
U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), a
`%` in a path segment, an escape that does not decode, and a path plus
query longer than `pathLimit` characters. The path is then split on `/`
into segments and the query into key and value pairs, percent-decoded with
`+` kept literal. Each segment carries the group id patterns it matches and
each query value the query value patterns of the loaded list it matches,
its `fits`. Matching patterns and scanning characters stay in the shell;
every decision is here.

## Story: Admit only the routes a product lists

> As the maker of a product that embeds the agent, I want the device to
> pass on only the requests my app's routes describe, so that a page can
> never ask the agent or the cloud for anything else.

### A route list is groups of routes, each segment a literal or its group's id

A route has a method, a path of literal and parameter segments, its
declared query keys, whether it streams, and an optional body limit in
bytes. A parameter matches one segment that fits its group's `id` pattern.
A declared query key takes any value, a value fitting a pattern, or one
pinned value (`ownerVisibleOnly=1`).

```quint
type Method = Get | Post | Put | Patch | Delete
type Delivery = Buffered | Streamed
type Piece = Literal({ text: str }) | Param
type Accept = AnyValue | Matching({ pattern: str }) | Pinned({ value: str })
type QueryRule = { key: str, accepts: Accept }
type BodyLimit = AnySize | AtMost({ bytes: int })
type Route = { method: Method, delivery: Delivery, path: List[Piece], query: List[QueryRule], limit: BodyLimit }
type Group = { prefixes: List[List[str]], id: str, routes: List[Route] }
type RouteList = List[Group]
type Segment = { text: str, fits: List[str] }
type QueryPair = { key: str, value: str, fits: List[str] }
type Flaw = Backslash | Fragment | UnsafeCharacter | PercentInPath | MalformedEscape | PathTooLong
type Body = NoBody | JsonObject({ size: int }) | NotAnObject
type Request = { method: Method, delivery: Delivery, segments: List[Segment], query: List[QueryPair], flaws: List[Flaw], body: Body }
type Admission = Admitted({ route: Route }) | RouteRefused | TooLarge
pure val flatParam: str = "[A-Za-z0-9_-]{1,128}"
pure val pathLimit: int = 2048
```

### A list is loaded whole or not at all

A list is refused whole when it is empty, a group has no prefix or no
route, a group repeats a prefix or two groups share one, a literal is
empty, `.` or `..`, a route names a query key twice or an empty one, a
body limit is not positive, or a group with a parameter has no id pattern.
A refused list replaces the one before it, so the gate then admits
nothing; it never falls back to an earlier or a wider list. A route outside
its group's prefixes is allowed and never tried.

```quint
type Table = Unloaded | Refused | Loaded({ groups: RouteList })
type Answer = Unanswered | Answered({ admission: Admission })
type RouteGate = { table: Table, answer: Answer }
type GateStep = { state: RouteGate, out: List[Admission] }
pure val initial: RouteGate = { table: Unloaded, answer: Unanswered }
pure def safeLiteral(text: str): bool = text != "" and text != "." and text != ".."
pure def isParam(p: Piece): bool = match p { | Param => true | _ => false }
pure def validPiece(p: Piece): bool = match p { | Literal(l) => safeLiteral(l.text) | _ => true }
pure def validLimit(limit: BodyLimit): bool = match limit { | AtMost(l) => l.bytes > 0 | _ => true }
pure def validTemplate(t: Route): bool =
  t.path.every(p => validPiece(p)) and validLimit(t.limit) and t.query.every(q => q.key != "" and t.query.select(o => o.key == q.key).length() == 1)
pure def validGroup(routes: RouteList, g: Group): bool =
  g.prefixes.length() > 0 and g.routes.length() > 0 and
    g.prefixes.every(p => p.every(text => safeLiteral(text)) and routes.select(h => h.prefixes.includes(p)).length() == 1 and g.prefixes.select(o => o == p).length() == 1) and
    g.routes.every(t => validTemplate(t)) and (g.id != "" or g.routes.every(t => not(t.path.some(p => isParam(p)))))
pure def validList(routes: RouteList): bool = routes.length() > 0 and routes.every(g => validGroup(routes, g))
pure def served(table: Table): RouteList = match table { | Loaded(l) => l.groups | _ => List() }
pure def load(gate: RouteGate, routes: RouteList): RouteGate =
  { table: if (validList(routes)) Loaded({ groups: routes }) else Refused, answer: Unanswered }
pure def alwaysServesOnlyAValidList(gate: RouteGate): bool = {
  val table = gate.table
  match table { | Loaded(l) => validList(l.groups) | _ => true }
}
pure def stepGateWithoutAListRefusesEverything(before: RouteGate, via: str, after: RouteGate, out: List[Admission]): bool =
  (via == "admit" and served(before.table) == List()) implies out == List(RouteRefused)
pure def sometimesListRefused(gate: RouteGate): bool = gate.table == Refused
```

### The longest claiming prefix chooses the one group whose routes are tried

A group claims a path whose leading segments equal one of its prefixes.
Only the group with the longest claiming prefix is consulted (no two groups
share a prefix, so it is one); a path it claims that none of its routes
matches is refused even when another group has a route that would match.

```quint
type Cursor = { at: int, ok: bool }
pure val noSegment: Segment = { text: "", fits: List() }
pure def leads(prefix: List[str], segments: List[Segment]): bool =
  prefix.length() <= segments.length() and prefix.foldl({ at: 0, ok: true }, (c, text) => { at: c.at + 1, ok: c.ok and segments.nthOr(c.at, noSegment).text == text }).ok
pure def claim(g: Group, segments: List[Segment]): int = g.prefixes.foldl(-1, (best, p) => if (p.length() > best and leads(p, segments)) p.length() else best)
pure def claimant(routes: RouteList, segments: List[Segment]): RouteList =
  routes.select(g => claim(g, segments) >= 0 and routes.every(h => claim(h, segments) <= claim(g, segments)))
```

### A request matches a route by method, delivery, every segment and every query key

The segment count must equal the route's. Each literal equals its segment
and each parameter's segment fits the group's id. Every query key given is
declared and its decoded value is accepted, and a pinned key is present
with exactly its value. A stream call matches only a route that streams
and a buffered call only one that does not.

```quint
pure def pieceFits(p: Piece, s: Segment, id: str): bool = match p { | Literal(l) => s.text == l.text | _ => s.fits.includes(id) }
pure def pathFits(t: Route, id: str, segments: List[Segment]): bool =
  t.path.length() == segments.length() and t.path.foldl({ at: 0, ok: true }, (c, p) => { at: c.at + 1, ok: c.ok and pieceFits(p, segments.nthOr(c.at, noSegment), id) }).ok
pure def acceptsValue(a: Accept, pair: QueryPair): bool = match a { | Matching(m) => pair.fits.includes(m.pattern) | Pinned(v) => pair.value == v.value | _ => true }
pure def pinnedPresent(q: QueryRule, query: List[QueryPair]): bool = {
  val accepts = q.accepts
  match accepts { | Pinned(v) => query.some(pair => pair.key == q.key and pair.value == v.value) | _ => true }
}
pure def queryFits(t: Route, query: List[QueryPair]): bool =
  query.every(pair => t.query.some(q => q.key == pair.key and acceptsValue(q.accepts, pair))) and t.query.every(q => pinnedPresent(q, query))
pure def templateAdmits(t: Route, id: str, request: Request): bool =
  t.method == request.method and t.delivery == request.delivery and pathFits(t, id, request.segments) and queryFits(t, request.query)
```

### A flawed request is refused before any route is tried

A request with a flaw, an empty, `.` or `..` path segment, a query key
given twice, a body that is present and not a JSON object, or a GET or
DELETE that has a body is `RouteRefused` whatever the list says.

```quint
pure def wellFormed(request: Request): bool =
  request.flaws.length() == 0 and request.body != NotAnObject and request.segments.every(s => safeLiteral(s.text)) and
    request.query.every(pair => request.query.select(o => o.key == pair.key).length() == 1) and
    not((request.method == Get or request.method == Delete) and request.body != NoBody)
pure def lawFlawedRequestIsRefused(routes: RouteList, request: Request): bool =
  not(wellFormed(request)) implies admission(routes, request) == RouteRefused
```

### The first matching route of the claiming group admits a request, or finds its body too large

The answer carries the admitted route. A matched body larger than that
route's limit is `TooLarge`; every other request is `RouteRefused`. The
shell dispatches only an admitted request.

```quint
pure val noGroup: Group = { prefixes: List(), id: "", routes: List() }
pure val noTemplate: Route = { method: Get, delivery: Buffered, path: List(), query: List(), limit: AnySize }
pure def bodySize(body: Body): int = match body { | JsonObject(o) => o.size | _ => 0 }
pure def withinLimit(limit: BodyLimit, body: Body): bool = match limit { | AtMost(l) => bodySize(body) <= l.bytes | _ => true }
pure def admission(routes: RouteList, request: Request): Admission = {
  val g = claimant(routes, request.segments).nthOr(0, noGroup)
  val matches = g.routes.select(t => templateAdmits(t, g.id, request))
  val t = matches.nthOr(0, noTemplate)
  if (not(wellFormed(request)) or matches.length() == 0) RouteRefused
  else if (not(withinLimit(t.limit, request.body))) TooLarge
  else Admitted({ route: t })
}
pure def admit(gate: RouteGate, request: Request): GateStep = {
  val a = admission(served(gate.table), request)
  { state: { ...gate, answer: Answered({ admission: a }) }, out: List(a) }
}
```

### An admitted request fits its route, which belongs to the longest claim

Whatever the list, an admitted request has its route's segment count,
gives no undeclared query key, carries every pinned key with its value and
fits the route's body limit, and the route belongs to a group whose claim
is the longest in the list.

```quint
pure def lawAdmittedRequestFitsItsTemplate(routes: RouteList, request: Request): bool = {
  val a = admission(routes, request)
  match a {
  | Admitted(x) => x.route.path.length() == request.segments.length() and withinLimit(x.route.limit, request.body) and
      request.query.every(pair => x.route.query.some(q => q.key == pair.key)) and x.route.query.every(q => pinnedPresent(q, request.query))
  | _ => true
  }
}
pure def lawLongestClaimWins(routes: RouteList, request: Request): bool = {
  val a = admission(routes, request)
  match a {
  | Admitted(x) => routes.some(g => g.routes.includes(x.route) and claim(g, request.segments) >= 0 and routes.every(h => claim(h, request.segments) <= claim(g, request.segments)))
  | _ => true
  }
}
```

### A product's list admits its buffered and streamed calls and refuses the rest

```quint
pure def admittedRoute(a: Admission): List[Route] = match a { | Admitted(x) => List(x.route) | _ => List() }
pure def lastRoute(answer: Answer): List[Route] = match answer { | Answered(x) => admittedRoute(x.admission) | _ => List() }
pure def sometimesBufferedCallAdmitted(gate: RouteGate): bool = lastRoute(gate.answer).some(t => t.delivery == Buffered and t.query.length() > 0)
pure def sometimesStreamCallAdmitted(gate: RouteGate): bool = lastRoute(gate.answer).some(t => t.delivery == Streamed)
pure def sometimesBodyTooLarge(gate: RouteGate): bool = gate.answer == Answered({ admission: TooLarge })
pure def sometimesListedGateRefuses(gate: RouteGate): bool = served(gate.table) != List() and gate.answer == Answered({ admission: RouteRefused })
pure val routesValues = {
  val api = Literal({ text: "api" })
  val talk = List(api, Literal({ text: "conversations" }), Param, Literal({ text: "messages" }))
  val rec = List(api, Literal({ text: "records" }))
  val cal = rec.append(Literal({ text: "calendar" }))
  val flat = { prefixes: List(List()), id: flatParam, routes: List(
    { method: Get, delivery: Buffered, path: List(api, Literal({ text: "status" })), query: List(), limit: AnySize },
    { method: Post, delivery: Streamed, path: talk.append(Literal({ text: "stream" })), query: List(), limit: AtMost({ bytes: 20 }) },
    { method: Post, delivery: Buffered, path: talk, query: List(), limit: AtMost({ bytes: 20 }) }) }
  val tasks = { prefixes: List(List("api", "records")), id: "slug", routes: List(
    { method: Get, delivery: Buffered, path: rec.append(Literal({ text: "tasks" })), query: List({ key: "ownerVisibleOnly", accepts: Pinned({ value: "1" }) }, { key: "view", accepts: AnyValue }), limit: AnySize },
    { method: Get, delivery: Buffered, path: cal.append(Literal({ text: "tasks" })), query: List(), limit: AnySize }) }
  val calendar = { prefixes: List(List("api", "records", "calendar")), id: "uuid", routes: List(
    { method: Get, delivery: Buffered, path: cal.append(Literal({ text: "feed" })), query: List({ key: "timeZone", accepts: Matching({ pattern: "zone" }) }), limit: AnySize },
    { method: Delete, delivery: Buffered, path: cal.concat(List(Literal({ text: "events" }), Param)), query: List(), limit: AnySize }) }
  Set(List(flat), List(tasks, calendar), List(tasks, calendar, flat), List({ ...flat, prefixes: List(List("..")) }), List(tasks, { ...calendar, prefixes: List(List("api", "records")) }), List())
}
pure val requestValues = {
  val api = { text: "api", fits: List() }
  val talk = List(api, { text: "conversations", fits: List() }, { text: "c1", fits: List(flatParam) }, { text: "messages", fits: List() })
  val cal = List(api, { text: "records", fits: List() }, { text: "calendar", fits: List() })
  val ask = { method: Get, delivery: Buffered, segments: List(api, { text: "status", fits: List() }), query: List(), flaws: List(), body: NoBody }
  val send = { ...ask, method: Post, delivery: Streamed, segments: talk.append({ text: "stream", fits: List() }), body: JsonObject({ size: 5 }) }
  val post = { ...send, delivery: Buffered, segments: talk }
  val feed = { ...ask, segments: cal.append({ text: "feed", fits: List() }), query: List({ key: "timeZone", value: "UTC", fits: List("zone") }) }
  val listTasks = { ...ask, segments: List(api, { text: "records", fits: List() }, { text: "tasks", fits: List() }),
    query: List({ key: "ownerVisibleOnly", value: "1", fits: List() }, { key: "view", value: "week", fits: List() }) }
  Set(ask, send, post, feed, listTasks, { ...send, delivery: Buffered }, { ...post, body: JsonObject({ size: 30 }) }, { ...post, body: NotAnObject },
    { ...ask, body: JsonObject({ size: 1 }) }, { ...ask, flaws: List(PercentInPath) }, { ...ask, flaws: List(PathTooLong) },
    { ...ask, segments: List(api, { text: "..", fits: List() }) }, { ...listTasks, query: List() }, { ...feed, query: List({ key: "x", value: "1", fits: List() }) },
    { ...feed, query: feed.query.concat(feed.query) }, { ...ask, segments: cal.append({ text: "tasks", fits: List() }) },
    { ...ask, method: Delete, segments: cal.concat(List({ text: "events", fits: List() }, { text: "e1", fits: List("uuid") })) })
}
```
