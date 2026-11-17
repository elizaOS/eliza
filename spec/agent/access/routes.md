# Route gate

The route list a product hands the device, and the gate that admits a
request against it before any I/O. A list is a set of groups; each group
claims the paths under its prefixes and lists the templates it serves. A
flat list is one group with the empty prefix. os imports this spec for its
native bridge (renderer and native callers, each with its own list) and for
the cloud requests of its sign-in plugin; its Java gate and the agent's
TypeScript gate are both checked against it by `driver:agent__access__routes`.
Which caller may call at all is local access, `access/auth.md`.

The shell decodes the wire form before the gate sees it. A literal is
`[A-Za-z0-9._-]+` and a method is one of the five below, or the list is
refused by its schema. A request path is split on `/` into segments and its
query into decoded key and value pairs; each segment and value carries the
id patterns of the loaded list it matches, its `fits`. The characters the
spec cannot read become flaws: a `\`, a fragment (`#`), a whitespace or
control character, a `%` in a path segment, and an escape that does not
decode. Matching patterns and scanning characters stay in the shell; every
decision is here.

## Story: Admit only the routes a product lists

> As the maker of a product that embeds the agent, I want the device to
> pass on only the requests my app's routes describe, so that a page can
> never ask the agent or the cloud for anything else.

### A route list is groups of templates, each segment a literal or its group's id

A template has a method, a path of literal and parameter segments, its
declared query keys, whether it streams, and an optional body limit in
bytes. A parameter matches one segment that fits its group's `id` pattern.
A query key takes either any value fitting a pattern or one pinned value
(`ownerVisibleOnly=1`).

```quint
type Method = Get | Post | Put | Patch | Delete
type Delivery = Buffered | Streamed
type Piece = Literal({ text: str }) | Param
type Accept = Matching({ pattern: str }) | Pinned({ value: str })
type QueryRule = { key: str, accepts: Accept }
type BodyLimit = AnySize | AtMost({ bytes: int })
type Template = { method: Method, delivery: Delivery, path: List[Piece], query: List[QueryRule], limit: BodyLimit }
type Group = { prefixes: List[List[str]], id: str, routes: List[Template] }
type Segment = { text: str, fits: List[str] }
type QueryPair = { key: str, value: str, fits: List[str] }
type Flaw = Backslash | Fragment | UnsafeCharacter | PercentInPath | MalformedEscape
type Body = NoBody | JsonObject({ size: int }) | NotAnObject
type Request = { method: Method, delivery: Delivery, segments: List[Segment], query: List[QueryPair], flaws: List[Flaw], body: Body }
type Admission = Admitted({ route: Template }) | RouteRefused | TooLarge
```

### A list is loaded whole or not at all

A list is refused whole when it is empty, a group has no prefix or no
route, two groups share a prefix, a literal is empty, `.` or
`..`, a template names a query key twice or an empty one, a body limit is
not positive, or a group with a parameter has no id pattern. A refused list
replaces the one before it, so the gate then admits nothing; it never falls
back to an earlier or a wider list.

```quint
type Table = Unloaded | Loaded({ groups: List[Group] })
type Answer = Unanswered | Answered({ admission: Admission })
type RouteGate = { table: Table, answer: Answer }
type GateStep = { state: RouteGate, out: List[Admission] }
pure val initial: RouteGate = { table: Unloaded, answer: Unanswered }
pure def safeLiteral(text: str): bool = text != "" and text != "." and text != ".."
pure def isParam(p: Piece): bool = match p { | Param => true | _ => false }
pure def validPiece(p: Piece): bool = match p { | Literal(l) => safeLiteral(l.text) | _ => true }
pure def validLimit(limit: BodyLimit): bool = match limit { | AtMost(l) => l.bytes > 0 | _ => true }
pure def validTemplate(t: Template): bool =
  t.path.every(p => validPiece(p)) and validLimit(t.limit) and t.query.every(q => q.key != "" and t.query.select(o => o.key == q.key).length() == 1)
pure def validGroup(routes: List[Group], g: Group): bool =
  g.prefixes.length() > 0 and g.routes.length() > 0 and
    g.prefixes.every(p => p.every(text => safeLiteral(text)) and routes.select(h => h.prefixes.includes(p)).length() == 1 and g.prefixes.select(o => o == p).length() == 1) and
    g.routes.every(t => validTemplate(t)) and (g.id != "" or g.routes.every(t => not(t.path.some(p => isParam(p)))))
pure def validList(routes: List[Group]): bool = routes.length() > 0 and routes.every(g => validGroup(routes, g))
pure def load(gate: RouteGate, routes: List[Group]): RouteGate = { ...gate, table: if (validList(routes)) Loaded({ groups: routes }) else Unloaded }
pure def alwaysServesOnlyAValidList(gate: RouteGate): bool = validList(served(gate.table)) or gate.table == Unloaded
```

### The longest claiming prefix chooses the one group whose templates are tried

A group claims a path whose leading segments equal one of its prefixes.
Only the group with the longest claiming prefix is consulted; a path it
claims that none of its templates matches is refused even when another
group has a template that would match.

```quint
type Cursor = { at: int, ok: bool }
pure val noSegment: Segment = { text: "", fits: List() }
pure def leads(prefix: List[str], segments: List[Segment]): bool =
  prefix.length() <= segments.length() and prefix.foldl({ at: 0, ok: true }, (c, text) => { at: c.at + 1, ok: c.ok and segments.nthOr(c.at, noSegment).text == text }).ok
pure def claim(g: Group, segments: List[Segment]): int = g.prefixes.foldl(-1, (best, p) => if (p.length() > best and leads(p, segments)) p.length() else best)
pure def longest(routes: List[Group], segments: List[Segment]): int = routes.foldl(-1, (top, g) => if (claim(g, segments) > top) claim(g, segments) else top)
pure def claimant(routes: List[Group], segments: List[Segment]): List[Group] = {
  val top = longest(routes, segments)
  routes.select(g => top >= 0 and claim(g, segments) == top)
}
```

### A request matches a template by method, delivery, every segment and every query key

The segment count must equal the template's. Each literal equals its
segment and each parameter's segment fits the group's id. Every query key
given is declared; a matching key's decoded value fits its pattern, and a
pinned key is present with exactly its value. A stream call matches only a
template that streams and a buffered call only one that does not.

```quint
pure def pieceFits(p: Piece, s: Segment, id: str): bool = match p { | Literal(l) => s.text == l.text | _ => s.fits.includes(id) }
pure def pathFits(t: Template, id: str, segments: List[Segment]): bool =
  t.path.length() == segments.length() and t.path.foldl({ at: 0, ok: true }, (c, p) => { at: c.at + 1, ok: c.ok and pieceFits(p, segments.nthOr(c.at, noSegment), id) }).ok
pure def isPinned(a: Accept): bool = match a { | Pinned(v) => true | _ => false }
pure def acceptsValue(a: Accept, pair: QueryPair): bool = match a { | Matching(m) => pair.fits.includes(m.pattern) | Pinned(v) => pair.value == v.value }
pure def queryFits(t: Template, query: List[QueryPair]): bool =
  query.every(pair => t.query.some(q => q.key == pair.key and acceptsValue(q.accepts, pair))) and
    t.query.every(q => not(isPinned(q.accepts)) or query.some(pair => pair.key == q.key))
pure def templateAdmits(t: Template, id: str, request: Request): bool =
  t.method == request.method and t.delivery == request.delivery and pathFits(t, id, request.segments) and queryFits(t, request.query)
```

### A flawed request is refused before any template is tried

A request with a flaw, an empty, `.` or `..` path segment, a query key
given twice, or a body that is present and not a JSON object is
`RouteRefused` whatever the list says.

```quint
pure def wellFormed(request: Request): bool =
  request.flaws.length() == 0 and request.body != NotAnObject and request.segments.every(s => safeLiteral(s.text)) and
    request.query.every(pair => request.query.select(o => o.key == pair.key).length() == 1)
```

### The gate answers each request once, a matched body over its limit as too large

The first template of the claiming group that matches admits the request,
and the answer carries that template. A body larger than its limit is
`TooLarge`; every other request is `RouteRefused`. The shell dispatches only
an admitted request; a gate with no list loaded refuses everything.

```quint
pure val noGroup: Group = { prefixes: List(), id: "", routes: List() }
pure val noTemplate: Template = { method: Get, delivery: Buffered, path: List(), query: List(), limit: AnySize }
pure def bodySize(body: Body): int = match body { | JsonObject(o) => o.size | _ => 0 }
pure def withinLimit(limit: BodyLimit, body: Body): bool = match limit { | AtMost(l) => bodySize(body) <= l.bytes | _ => true }
pure def admission(routes: List[Group], request: Request): Admission = {
  val g = claimant(routes, request.segments).nthOr(0, noGroup)
  val matches = g.routes.select(t => templateAdmits(t, g.id, request))
  val t = matches.nthOr(0, noTemplate)
  if (not(wellFormed(request)) or matches.length() == 0) RouteRefused
  else if (not(withinLimit(t.limit, request.body))) TooLarge
  else Admitted({ route: t })
}
pure def served(table: Table): List[Group] = match table { | Loaded(l) => l.groups | _ => List() }
pure def admit(gate: RouteGate, request: Request): GateStep = {
  val a = admission(served(gate.table), request)
  { state: { ...gate, answer: Answered({ admission: a }) }, out: List(a) }
}
pure def stepUnloadedGateRefusesEverything(before: RouteGate, via: str, after: RouteGate, out: List[Admission]): bool =
  (via == "admit" and before.table == Unloaded) implies out == List(RouteRefused)
```

### An admitted request fits its template, which belongs to the longest claim

Whatever the list, an admitted request has its template's segment count,
method and delivery, gives no undeclared query key and fits the template's
body limit, and the template belongs to a group whose claim is the longest
in the list. A flawed request is never admitted.

```quint
pure def lawAdmittedRequestFitsItsTemplate(routes: List[Group], request: Request): bool = {
  val a = admission(routes, request)
  match a {
  | Admitted(x) => x.route.path.length() == request.segments.length() and x.route.method == request.method and x.route.delivery == request.delivery and
      withinLimit(x.route.limit, request.body) and request.query.every(pair => x.route.query.some(q => q.key == pair.key))
  | _ => true
  }
}
pure def lawLongestClaimWins(routes: List[Group], request: Request): bool = {
  val a = admission(routes, request)
  match a {
  | Admitted(x) => routes.some(g => g.routes.includes(x.route) and claim(g, request.segments) >= 0 and routes.every(h => claim(h, request.segments) <= claim(g, request.segments)))
  | _ => true
  }
}
pure def lawFlawedRequestIsRefused(routes: List[Group], request: Request): bool =
  (request.flaws.length() > 0 or request.body == NotAnObject or request.segments.some(s => s.text == "." or s.text == "..")) implies admission(routes, request) == RouteRefused
```

### A product's list admits its buffered and streamed calls and refuses the rest

The simulator loads a flat list, a grouped list and broken lists, and sends
calls each list admits, refuses or finds too large.

```quint
pure def admittedRoute(a: Admission): List[Template] = match a { | Admitted(x) => List(x.route) | _ => List() }
pure def lastRoute(answer: Answer): List[Template] = match answer { | Answered(x) => admittedRoute(x.admission) | _ => List() }
pure def sometimesBufferedCallAdmitted(gate: RouteGate): bool = lastRoute(gate.answer).some(t => t.delivery == Buffered and t.query.length() > 0)
pure def sometimesStreamCallAdmitted(gate: RouteGate): bool = lastRoute(gate.answer).some(t => t.delivery == Streamed)
pure def sometimesBodyTooLarge(gate: RouteGate): bool = gate.answer == Answered({ admission: TooLarge })
pure def sometimesListedGateRefuses(gate: RouteGate): bool = gate.table != Unloaded and gate.answer == Answered({ admission: RouteRefused })
pure def lit(text: str): Piece = Literal({ text: text })
pure def seg(text: str): Segment = { text: text, fits: List() }
pure def idSeg(text: str, pattern: str): Segment = { text: text, fits: List(pattern) }
pure val flat: Group = { prefixes: List(List()), id: "word", routes: List(
  { method: Get, delivery: Buffered, path: List(lit("api"), lit("status")), query: List(), limit: AnySize },
  { method: Post, delivery: Streamed, path: List(lit("api"), lit("conversations"), Param, lit("messages"), lit("stream")), query: List(), limit: AtMost({ bytes: 20 }) },
  { method: Post, delivery: Buffered, path: List(lit("api"), lit("conversations"), Param, lit("messages")), query: List(), limit: AtMost({ bytes: 20 }) }) }
pure val tasks: Group = { prefixes: List(List("api", "records")), id: "slug", routes: List(
  { method: Get, delivery: Buffered, path: List(lit("api"), lit("records"), lit("tasks")), query: List({ key: "ownerVisibleOnly", accepts: Pinned({ value: "1" }) }), limit: AnySize }) }
pure val calendar: Group = { prefixes: List(List("api", "records", "calendar")), id: "uuid", routes: List(
  { method: Get, delivery: Buffered, path: List(lit("api"), lit("records"), lit("calendar"), lit("feed")), query: List({ key: "timeZone", accepts: Matching({ pattern: "zone" }) }), limit: AnySize },
  { method: Delete, delivery: Buffered, path: List(lit("api"), lit("records"), lit("calendar"), lit("events"), Param), query: List(), limit: AnySize }) }
pure val routesValues = Set(List(flat), List(tasks, calendar), List(tasks, calendar, flat), List({ ...flat, prefixes: List(List("..")) }), List(tasks, { ...calendar, prefixes: List(List("api", "records")) }), List())
pure val ask: Request = { method: Get, delivery: Buffered, segments: List(seg("api"), seg("status")), query: List(), flaws: List(), body: NoBody }
pure val send: Request = { method: Post, delivery: Streamed, segments: List(seg("api"), seg("conversations"), idSeg("c1", "word"), seg("messages"), seg("stream")), query: List(), flaws: List(), body: JsonObject({ size: 5 }) }
pure val post: Request = { ...send, delivery: Buffered, segments: List(seg("api"), seg("conversations"), idSeg("c1", "word"), seg("messages")) }
pure val feed: Request = { ...ask, segments: List(seg("api"), seg("records"), seg("calendar"), seg("feed")), query: List({ key: "timeZone", value: "UTC", fits: List("zone") }) }
pure val listTasks: Request = { ...ask, segments: List(seg("api"), seg("records"), seg("tasks")), query: List({ key: "ownerVisibleOnly", value: "1", fits: List() }) }
pure val requestValues = Set(ask, send, post, feed, listTasks,
  { ...send, delivery: Buffered }, { ...post, body: JsonObject({ size: 30 }) }, { ...post, body: NotAnObject }, { ...ask, flaws: List(PercentInPath) },
  { ...ask, segments: List(seg("api"), seg(".."), seg("status")) }, { ...listTasks, query: List() }, { ...feed, query: List({ key: "x", value: "1", fits: List() }) },
  { ...feed, query: List({ key: "timeZone", value: "UTC", fits: List("zone") }, { key: "timeZone", value: "GMT", fits: List("zone") }) },
  { ...ask, method: Delete, segments: List(seg("api"), seg("records"), seg("calendar"), seg("events"), idSeg("e1", "uuid")) })
```
