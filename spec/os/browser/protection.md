# Browser protection

The owned browser blocks hosts named by reviewed public threat lists, and the
device answers "is this site known to be harmful?" from the lists it has
actually loaded. A site no list names is never blocked, and a list that
failed to load is never read as "safe". Only the fixed public list
addresses are fetched; a visited address is never sent, saved or logged.

The shell downloads and parses the lists, writes the browser's network
rules, matches a host and its whole-label ancestors (`a.example.test`
matches a listed `example.test`, `notexample.test` does not) and reads
registrable domains; this file decides what those facts mean, over the
addresses of [Browser address](./address.md).

## Story: Block known-bad sites without blocking unknown ones

> As a person browsing, I want sites on the reviewed threat lists stopped
> before they open, and a page I chose to open anyway opened only once, so
> that protection neither silently weakens nor spreads.

### A list is admitted only when it arrived whole, holds at least 1,000 hosts and at most one malformed line per hundred hosts

The shell reads the body as a stream and stops past 24 MiB. Hosts are
lowercased and deduplicated; blank and `#` lines are skipped. A list is
never cut down to fit, so more bytes or more malformed lines never turn a
refusal into an admission.

```quint
import address.* from "./address"
type FeedBody = { reachable: bool, bytes: int, uniqueHosts: int, malformedLines: int }
type FeedRefusal = FeedUnreachable | FeedTooLarge | FeedTooFewHosts | FeedMalformed
type FeedAdmission = FeedAdmitted | FeedRefused({ reason: FeedRefusal })
pure val feedBytesLimit = 25165824
pure val feedMinimumHosts = 1000
pure def admitFeed(body: FeedBody): FeedAdmission =
  if (not(body.reachable)) FeedRefused({ reason: FeedUnreachable })
  else if (body.bytes > feedBytesLimit) FeedRefused({ reason: FeedTooLarge })
  else if (body.uniqueHosts < feedMinimumHosts) FeedRefused({ reason: FeedTooFewHosts })
  else if (body.malformedLines * 100 > body.uniqueHosts) FeedRefused({ reason: FeedMalformed })
  else FeedAdmitted
pure def lawGrowingBodyNeverTurnsRefusalIntoAdmission(body: FeedBody): bool =
  admitFeed(body) != FeedAdmitted implies
    (admitFeed({ ...body, bytes: body.bytes + 1 }) != FeedAdmitted and admitFeed({ ...body, malformedLines: body.malformedLines + 1 }) != FeedAdmitted)
pure val wholeList: FeedBody = { reachable: true, bytes: 25165824, uniqueHosts: 1000, malformedLines: 10 }
pure val bodyValues: Set[FeedBody] = Set(wholeList, { ...wholeList, malformedLines: 11 }, { ...wholeList, uniqueHosts: 999 },
  { ...wholeList, bytes: 25165825 }, { ...wholeList, reachable: false })
```

### A rule set holds 1 to 1,200,000 hosts and at most 100 reviewed never-block hosts, and every rule it writes lies in the browser's owned range

Each chunk of 2,000 hosts writes a pair of rules: an even one that blocks
the hosts' subresources and an odd one that sends a top-level visit to the
warning page. The browser replaces only rule IDs in [10000, 12000) and
keeps every other rule. A never-block host is a reviewed false positive; it
excludes itself and its whole-label descendants from every rule.

```quint
type RuleKind = BlockSubresources | WarnTopLevel
pure val ruleSetHostsLimit = 1200000
pure val neverBlockLimit = 100
pure val ruleChunkHosts = 2000
pure val ownedRuleBase = 10000
pure val ownedRuleEnd = 12000
pure def ruleSetAdmitted(hostCount: int, neverBlockCount: int): bool =
  hostCount >= 1 and hostCount <= ruleSetHostsLimit and neverBlockCount >= 0 and neverBlockCount <= neverBlockLimit
pure def ruleCountFor(hostCount: int): int = 2 * ((hostCount + ruleChunkHosts - 1) / ruleChunkHosts)
pure def ruleKindAt(ruleIndex: int): RuleKind = if (ruleIndex % 2 == 0) BlockSubresources else WarnTopLevel
pure def ownsRuleId(id: int): bool = id >= ownedRuleBase and id < ownedRuleEnd
pure def lawRulesStayInOwnedRange(hostCount: int, neverBlockCount: int, ruleIndex: int): bool =
  (ruleSetAdmitted(hostCount, neverBlockCount) and ruleIndex >= 0 and ruleIndex < ruleCountFor(hostCount)) implies
    ownsRuleId(ownedRuleBase + ruleIndex)
pure val hostCountValues = Set(0, 1, 2000, 2001, 1200000, 1200001)
pure val ruleIndexValues = Set(-1, 0, 1, 2, 3, 1199, 1200)
```

### A temporary exception is granted only to the warning page of a tab, for one plain web address of at most 800 units

Only the browser's own warning page, in the top frame of a tab, can ask.
A website, a frame or a content script cannot grant itself an exception.
The shell clears the fragment before it builds the address.

```quint
type ExceptionAsker = OwnWarningPage({ tab: int }) | OtherAsker
type ExceptionDecision = ExceptionAdmitted({ tab: int, href: str }) | ExceptionRefused
pure val exceptionUnitsLimit = 800
pure val exceptionLifetimeMs = 60000
pure def decideException(asker: ExceptionAsker, address: WebAddress): ExceptionDecision = match asker {
  | OwnWarningPage(p) =>
    if (p.tab >= 0 and isWebAddress(address) and address.units <= exceptionUnitsLimit) ExceptionAdmitted({ tab: p.tab, href: address.href })
    else ExceptionRefused
  | _ => ExceptionRefused
}
pure def lawOnlyTheWarningPageGetsAnException(asker: ExceptionAsker, address: WebAddress): bool =
  decideException(asker, address) != ExceptionRefused implies (asker != OtherAsker and isWebAddress(address))
pure val askerValues: Set[ExceptionAsker] = Set(OwnWarningPage({ tab: 3 }), OwnWarningPage({ tab: -1 }), OtherAsker)
```

### At most one exception exists, and it ends when its page commits, its tab closes, its minute passes or the navigation fails

```quint
type ExceptionSlot = NoException | HeldException({ tab: int, href: str })
type ExceptionChange = GrantException({ tab: int, href: str }) | CommitTopFrame({ tab: int }) | CloseTab({ tab: int }) | WithdrawException
pure def heldTab(slot: ExceptionSlot): int = match slot { | HeldException(e) => e.tab | _ => -1 }
pure def exceptionAfter(slot: ExceptionSlot, change: ExceptionChange): ExceptionSlot = match change {
  | GrantException(g) => HeldException({ tab: g.tab, href: g.href })
  | CommitTopFrame(c) => if (heldTab(slot) == c.tab) NoException else slot
  | CloseTab(c) => if (heldTab(slot) == c.tab) NoException else slot
  | _ => NoException
}
pure def lawExceptionEndsWithItsPage(slot: ExceptionSlot, change: ExceptionChange): bool = {
  val after = exceptionAfter(slot, change)
  match change {
    | CommitTopFrame(c) => after == NoException or heldTab(after) != c.tab
    | CloseTab(c) => after == NoException or heldTab(after) != c.tab
    | WithdrawException => after == NoException
    | _ => true
  }
}
pure val slotValues: Set[ExceptionSlot] = Set(NoException, HeldException({ tab: 3, href: "https://example.test/" }))
pure val changeValues: Set[ExceptionChange] = Set(GrantException({ tab: 4, href: "https://other.test/" }),
  CommitTopFrame({ tab: 3 }), CommitTopFrame({ tab: 4 }), CloseTab({ tab: 3 }), CloseTab({ tab: 4 }), WithdrawException)
```

### A listed host is warned at the top level and blocked below it, unless never-blocked or opened by the matching exception

The exception matches only its tab, its exact case-sensitive address, a
top-level request and the GET method. It never allows another tab, address,
frame, resource or method.

```quint
type RequestFrame = TopFrame | SubFrameOrResource
type RequestMethod = GetMethod | OtherMethod
type ProtectedRequest = { tab: int, href: str, frame: RequestFrame, method: RequestMethod, listed: bool, neverBlocked: bool }
type RequestOutcome = RequestPasses | RequestBlocked | WarningShown | ExceptionOpens
pure def exceptionMatches(slot: ExceptionSlot, request: ProtectedRequest): bool = match slot {
  | HeldException(e) => e.tab == request.tab and e.href == request.href and request.frame == TopFrame and request.method == GetMethod
  | _ => false
}
pure def requestOutcome(slot: ExceptionSlot, request: ProtectedRequest): RequestOutcome =
  if (not(request.listed) or request.neverBlocked) RequestPasses
  else if (exceptionMatches(slot, request)) ExceptionOpens
  else if (request.frame == TopFrame) WarningShown
  else RequestBlocked
pure def lawListedHostOpensOnlyThroughItsException(slot: ExceptionSlot, request: ProtectedRequest): bool =
  (request.listed and not(request.neverBlocked)) implies
    (requestOutcome(slot, request) != RequestPasses and
      (requestOutcome(slot, request) == ExceptionOpens implies
        (heldTab(slot) == request.tab and request.frame == TopFrame and request.method == GetMethod)))
pure val listedVisit: ProtectedRequest = { tab: 3, href: "https://example.test/", frame: TopFrame, method: GetMethod, listed: true, neverBlocked: false }
pure val requestValues: Set[ProtectedRequest] = Set(listedVisit, { ...listedVisit, tab: 4 }, { ...listedVisit, href: "https://example.test/a" },
  { ...listedVisit, frame: SubFrameOrResource }, { ...listedVisit, method: OtherMethod }, { ...listedVisit, neverBlocked: true },
  { ...listedVisit, listed: false })
```

## Story: Check a site against the lists this device has loaded

> As a person, I want a site checked against the threat lists my device has
> actually loaded, and look-alike addresses pointed out, so that a list that
> failed to load is reported rather than read as safe.

### A check uses one to eight distinct reviewed lists in their configured order

```quint
pure val feedConfigLimit = 8
pure def feedsConfigured(feedIds: List[str]): bool =
  feedIds.length() >= 1 and feedIds.length() <= feedConfigLimit and
    feedIds.foldl(Set(), (seen, id) => seen.union(Set(id))).size() == feedIds.length()
pure def lawRepeatedListIsRefused(id: str): bool = not(feedsConfigured(List(id, id)))
```

### A loaded list counts at any age, and its age only makes a refresh due

A refresh is due when no list is loaded, or the loaded one is six hours
old or has a time more than five minutes ahead. One refresh per list runs
at a time. Any refresh that ends, failed or not, waits a minute before the
next; a failed one keeps the list already loaded.

```quint
type FeedSnapshot = NoList | LoadedList({ downloadedAt: int })
type FeedRefresh = RefreshIdle({ retryAfter: int }) | RefreshRunning | RefreshStopped
type FeedTrack = { snapshot: FeedSnapshot, refresh: FeedRefresh }
type DownloadResult = Downloaded({ downloadedAt: int }) | DownloadFailed
pure val clockSkewMs = 300000
pure val refreshAfterMs = 21600000
pure val retryAfterMs = 60000
pure def plausibleTime(time: int, now: int): bool = time <= now + clockSkewMs
pure def listFresh(snapshot: FeedSnapshot, now: int): bool = match snapshot {
  | LoadedList(l) => plausibleTime(l.downloadedAt, now) and now - l.downloadedAt < refreshAfterMs
  | _ => false
}
pure def refreshDue(track: FeedTrack, now: int): bool = {
  val refresh = track.refresh
  match refresh { | RefreshIdle(r) => now >= r.retryAfter and not(listFresh(track.snapshot, now)) | _ => false }
}
pure def refreshEnded(result: DownloadResult, track: FeedTrack, now: int): FeedTrack = {
  val waiting = RefreshIdle({ retryAfter: now + retryAfterMs })
  match result {
    | Downloaded(d) => if (plausibleTime(d.downloadedAt, now)) { snapshot: LoadedList({ downloadedAt: d.downloadedAt }), refresh: waiting }
                       else { ...track, refresh: waiting }
    | _ => { ...track, refresh: waiting }
  }
}
pure def lawFailedRefreshKeepsListAndWaits(track: FeedTrack, now: int): bool = {
  val after = refreshEnded(DownloadFailed, track, now)
  after.snapshot == track.snapshot and not(refreshDue(after, now + retryAfterMs - 1))
}
pure val trackValues: Set[FeedTrack] = Set({ snapshot: NoList, refresh: RefreshIdle({ retryAfter: 0 }) },
  { snapshot: LoadedList({ downloadedAt: 0 }), refresh: RefreshIdle({ retryAfter: 0 }) },
  { snapshot: LoadedList({ downloadedAt: 0 }), refresh: RefreshRunning }, { snapshot: NoList, refresh: RefreshStopped })
pure val nowValues = Set(0, 60000, 21600000, 21700000)
```

### A hit in any loaded list blocks, a loaded list without a hit is no known threat, and with no list loaded the site is unscanned, never clean

Only an HTTPS web address of at most 4,096 units is checked; a host with
no dot, an IPv4 address or a bracketed literal is local. A block names the
first list, in configured order, that hit.

```quint
type FeedLookup = ListNotLoaded | ListClear | ListHit
type ReputationQuery = { site: WebAddress, localHost: bool }
type UnscannedReason = InvalidSiteAddress | LocalSiteAddress | ListsUnavailable
type SiteVerdict = SiteBlocked({ feed: int }) | NoKnownThreat | Unscanned({ reason: UnscannedReason })
pure val reputationUnitsLimit = 4096
type HitScan = { scanned: int, hit: int }
pure val noHitYet: HitScan = { scanned: 0, hit: -1 }
pure def scanLookup(acc: HitScan, l: FeedLookup): HitScan =
  { scanned: acc.scanned + 1, hit: if (acc.hit < 0 and l == ListHit) acc.scanned else acc.hit }
pure def firstHit(lookups: List[FeedLookup]): int = lookups.foldl(noHitYet, scanLookup).hit
pure def siteVerdict(query: ReputationQuery, lookups: List[FeedLookup]): SiteVerdict =
  if (not(isSecureWebAddress(query.site)) or query.site.units > reputationUnitsLimit) Unscanned({ reason: InvalidSiteAddress })
  else if (query.localHost) Unscanned({ reason: LocalSiteAddress })
  else if (firstHit(lookups) >= 0) SiteBlocked({ feed: firstHit(lookups) })
  else if (lookups.includes(ListClear)) NoKnownThreat
  else Unscanned({ reason: ListsUnavailable })
pure def lawNoLoadedListIsNeverClean(query: ReputationQuery, lookups: List[FeedLookup]): bool =
  siteVerdict(query, lookups) == NoKnownThreat implies lookups.includes(ListClear)
pure def lawAnyLoadedHitBlocks(query: ReputationQuery, lookups: List[FeedLookup]): bool = {
  val verdict = siteVerdict(query, lookups)
  (isSecureWebAddress(query.site) and query.site.units <= reputationUnitsLimit and not(query.localHost) and lookups.includes(ListHit)) implies
    (match verdict { | SiteBlocked(b) => lookups.nthOr(b.feed, ListNotLoaded) == ListHit | _ => false })
}
pure val queryValues: Set[ReputationQuery] = Set({ site: secureAddress, localHost: false }, { site: secureAddress, localHost: true },
  { site: { ...secureAddress, href: "http://example.test/", units: 20, scheme: HttpScheme }, localHost: false })
```

### A look-alike is advice about a registrable domain that is not itself a reference site, and the site verdict never reads it

`resemblesSite` is the shell's suspicion signal: the host holds the
reference as whole labels, or the domain spelled after folding common
Greek, Cyrillic and Latin confusables equals it, or a registrable label of
at least five letters equals the reference's or is one edit or swap away.

```quint
const resemblesSite: (str, str) => bool
type Lookalike = NotLookalike | LooksLike({ suggested: str })
pure def lawNoSiteResemblesItself(reference: str): bool = not(resemblesSite(reference, reference))
pure def lookalikeOf(host: str, domain: str, references: List[str]): Lookalike =
  if (references.includes(domain)) NotLookalike
  else references.foldl(NotLookalike, (found, reference) =>
    if (found == NotLookalike and resemblesSite(host, reference)) LooksLike({ suggested: reference }) else found)
```

### A page shows look-alike advice always, unscanned advice only as the build chose, and a mark only for the same finding and a bound owner

The build chooses whether a page the lists could not cover shows the
unscanned bar, and whether it does while the first lists still download.
"Mark as not suspicious" belongs to the bound owner and to what was found;
a different finding, or another owner, shows the page unmarked.

```quint
type ListsStatus = ListsCurrent | ListsLoading | ListsMissing
type UnscannedPolicy = { showUnscanned: bool, showWhileLoading: bool }
type AdviceOwner = OwnerBound | NoOwner
type AdviceEvidence = SimilarTo({ reference: str }) | ListsLoaded | ListsNotLoaded
type AdviceMark = NotMarked | MarkedFor({ evidence: AdviceEvidence })
type PageAdvice = NoAdvice | LookalikeAdvice({ suggested: str, marked: bool }) | UnscannedAdvice({ marked: bool })
pure def adviceEvidence(similar: Lookalike, lists: ListsStatus): AdviceEvidence = match similar {
  | LooksLike(l) => SimilarTo({ reference: l.suggested })
  | _ => if (lists == ListsCurrent) ListsLoaded else ListsNotLoaded
}
pure def pageAdvice(similar: Lookalike, lists: ListsStatus, policy: UnscannedPolicy, owner: AdviceOwner, mark: AdviceMark): PageAdvice = {
  val marked = owner == OwnerBound and mark == MarkedFor({ evidence: adviceEvidence(similar, lists) })
  match similar {
    | LooksLike(l) => LookalikeAdvice({ suggested: l.suggested, marked: marked })
    | _ => if (lists != ListsCurrent and policy.showUnscanned and (lists != ListsLoading or policy.showWhileLoading)) UnscannedAdvice({ marked: marked })
           else NoAdvice
  }
}
pure def lawLookalikeAlwaysAdvises(similar: Lookalike, lists: ListsStatus, policy: UnscannedPolicy, owner: AdviceOwner, mark: AdviceMark): bool =
  similar != NotLookalike implies pageAdvice(similar, lists, policy, owner, mark) != NoAdvice
pure def lawUnscannedMarkNeverHidesALookalike(similar: Lookalike, lists: ListsStatus, policy: UnscannedPolicy, owner: AdviceOwner): bool = {
  val advice = pageAdvice(similar, lists, policy, owner, MarkedFor({ evidence: ListsNotLoaded }))
  similar != NotLookalike implies (match advice { | LookalikeAdvice(a) => not(a.marked) | _ => false })
}
pure val similarValues: Set[Lookalike] = Set(NotLookalike, LooksLike({ suggested: "example.test" }))
pure val policyValues: Set[UnscannedPolicy] = Set({ showUnscanned: true, showWhileLoading: true }, { showUnscanned: true, showWhileLoading: false },
  { showUnscanned: false, showWhileLoading: false })
pure val markValues: Set[AdviceMark] = Set(NotMarked, MarkedFor({ evidence: ListsNotLoaded }), MarkedFor({ evidence: SimilarTo({ reference: "example.test" }) }))
```
