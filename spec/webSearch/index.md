# Web search

Search through the owner's explicitly selected browser profile when it can
perform the query. The keyless HTTP provider is an independent fallback
during route selection. A browser dispatch commits the search to that
profile and tab. Edge provider policy, public article fetches, typed outage
classification, and compact snippet bounds are specified in
[Edge search and public fetch policy](./edge.md).

## Story: Search the web through my selected profile

> As the owner, I want links and excerpts from my search, using my authorized
> profile when it can answer the request.

### Selection binds the destination before issuing the query

A provider-specific filter or unavailable profile can select the keyless API
before either destination receives the query. A corrupt saved selection
refuses instead of treating it as an absent selection. The adapter parses the
browser target and profile IDs, browser capabilities, and provider filters
before routing. The shell trims and counts Unicode code points in the
query. Require one to 2048 code points. Each search runs on its own machine.

```quint
type BrowserSelection = Disabled | Missing | Invalid | Ready({ targetId: str, profileId: str })
type SearchRoute = Browser({ target: str, profile: str }) | Keyless | RefuseSearch
pure def routeSearch(selection: BrowserSelection, supportsFilters: bool, targetReady: bool): SearchRoute =
  match selection {
    | Invalid => RefuseSearch
    | Ready(ids) => if (supportsFilters and targetReady and ids.targetId != "" and ids.profileId != "") Browser({ target: ids.targetId, profile: ids.profileId }) else Keyless
    | _ => Keyless
  }
pure def lawInvalidSelectionRefuses(supportsFilters: bool, targetReady: bool): bool =
  routeSearch(Invalid, supportsFilters, targetReady) == RefuseSearch
pure def lawProviderFiltersStayOnApi(targetId: str, profileId: str, targetReady: bool): bool =
  routeSearch(Ready({ targetId: targetId, profileId: profileId }), false, targetReady) == Keyless
```

### Browser reads stay on the dispatched target profile and tab

The browser adapter returns a complete result only for the exact target
and profile that opened the search and for the same browser tab. An
unavailable, wrong, or incomplete reply after dispatch is a failure of
that search. Only a completed search may report zero results.

```quint
type SearchPhase = Unsent | Opening | OpenTab | CallingApi | Found | NoHits | SearchFailed
type Search = { phase: SearchPhase, query: str, route: SearchRoute, tabId: str, hits: int }
pure val initial: Search = { phase: Unsent, query: "", route: RefuseSearch, tabId: "", hits: 0 }
pure def canDispatchSearch(s: Search, query: str, queryUnits: int): bool =
  s.phase == Unsent and query != "" and queryUnits > 0 and queryUnits <= 2048
pure def dispatchSearch(s: Search, query: str, queryUnits: int, selection: BrowserSelection, supportsFilters: bool, targetReady: bool): Search = {
  val chosen = routeSearch(selection, supportsFilters, targetReady)
  val phase = match chosen {
    | Browser(_) => Opening
    | Keyless => CallingApi
    | RefuseSearch => SearchFailed
  }
  { ...s, phase: phase, query: query, route: chosen }
}
pure def browserMatches(route: SearchRoute, targetId: str, profileId: str): bool =
  match route {
    | Browser(ids) => ids.target == targetId and ids.profile == profileId
    | _ => false
  }
pure def canOpenSearchTab(s: Search, targetId: str, profileId: str, tabId: str): bool =
  s.phase == Opening and browserMatches(s.route, targetId, profileId) and tabId != ""
pure def openSearchTab(s: Search, targetId: str, profileId: str, tabId: str): Search =
  { ...s, phase: OpenTab, tabId: tabId }
pure def canReadSearchTab(s: Search, targetId: str, profileId: str, tabId: str, complete: bool, resultCount: int): bool =
  s.phase == OpenTab and browserMatches(s.route, targetId, profileId) and s.tabId == tabId and complete and resultCount >= 0
pure def readSearchTab(s: Search, targetId: str, profileId: str, tabId: str, complete: bool, resultCount: int): Search =
  { ...s, phase: if (resultCount == 0) NoHits else Found, hits: resultCount }
pure def canReadKeylessSearch(s: Search, resultCount: int): bool = s.phase == CallingApi and resultCount >= 0
pure def readKeylessSearch(s: Search, resultCount: int): Search =
  { ...s, phase: if (resultCount == 0) NoHits else Found, hits: resultCount }
pure def canFailSearch(s: Search): bool = s.phase == Opening or s.phase == OpenTab or s.phase == CallingApi
pure def failSearch(s: Search): Search = { ...s, phase: SearchFailed }
pure def stepRouteRemainsBound(before: Search, after: Search): bool =
  before.phase != Unsent implies before.route == after.route and before.query == after.query
pure def alwaysSearchOutcomeMatchesCount(s: Search): bool =
  (s.phase == Found implies s.hits > 0) and (s.phase != Found implies s.hits == 0)
pure val selectionValues = Set(Disabled, Missing, Invalid, Ready({ targetId: "device", profileId: "owner" }))
pure val queryValues = Set("", "train schedules")
pure val targetIdValues = Set("device", "other")
pure val profileIdValues = Set("owner", "other")
pure val tabIdValues = Set("", "12", "13")
pure def sometimesBrowserFindsHits(s: Search): bool = s.phase == Found and s.tabId != ""
pure val eval_witness_sometimesBrowserFindsHits = (("dispatchSearch", "train schedules", 15, Ready({ targetId: "device", profileId: "owner" }), true, true), ("openSearchTab", "device", "owner", "12"), ("readSearchTab", "device", "owner", "12", true, 2))
pure def sometimesApiReturnsNoHits(s: Search): bool = s.phase == NoHits and s.route == Keyless
pure val eval_witness_sometimesApiReturnsNoHits = (("dispatchSearch", "train schedules", 15, Disabled, true, false), ("readKeylessSearch", 0))
```

### A citation needs a usable web destination and a heading

The adapter normalizes redirects on the search page into destinations and
parses each URL. A usable citation has a nonempty heading, uses HTTP or
HTTPS, carries no URL credentials, and does not address the search UI
itself. The public evidence adapter also excludes private destinations.
Public evidence is scoped to the exact result record that reported a URL.
Preserve page text when an individual link is unusable.

```quint
type SearchLink = { destination: str, heading: str, isWeb: bool, hasCredentials: bool, isSearchControl: bool, destinationPublic: bool }
pure def usableCitation(link: SearchLink): bool =
  link.destination != "" and link.heading != "" and link.isWeb and not(link.hasCredentials) and not(link.isSearchControl) and link.destinationPublic
pure val linkValues: Set[SearchLink] = Set(
  { destination: "https://rail.example/schedules", heading: "Schedules", isWeb: true, hasCredentials: false, isSearchControl: false, destinationPublic: true },
  { destination: "https://rail.example/schedules", heading: "Schedules", isWeb: true, hasCredentials: true, isSearchControl: false, destinationPublic: true },
  { destination: "http://localhost", heading: "Private", isWeb: true, hasCredentials: false, isSearchControl: false, destinationPublic: false })
pure val resultSourceValues = Set("", "https://rail.example/schedules", "https://other.example")
pure val resultTextValues = Set("", "Schedule details")
pure val visitedValues = Set(0, 1, 512, 513)
pure def lawCredentialsNeverCited(link: SearchLink): bool = link.hasCredentials implies not(usableCitation(link))
pure def sourceBoundEvidence(link: SearchLink, resultSource: str, resultText: str, visited: int): bool =
  usableCitation(link) and link.destination == resultSource and resultText != "" and visited > 0 and visited <= 512
pure def lawEvidenceCannotBorrowSource(link: SearchLink, resultSource: str, resultText: str, visited: int): bool =
  link.destination != resultSource implies not(sourceBoundEvidence(link, resultSource, resultText, visited))
```
