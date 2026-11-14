# Grace browser feed and temporary exception contracts

Grace's `apps/app/browser-protection/feed-sources.ts` binds its reviewed
phishing and threats feeds to `packages/os/browser/protection/policy.mjs`
at Eliza `7743504b7c936a764b3938a44cad918808b621df`. Both the Chromium
extension build and native lookup use the selected feed records. Provenance
records and retained notices come from the pinned Grace tree. The
[website guidance](./grace/websiteGuide.md) state owns the task and
user's active browser command.

## Story: Apply the selected protection feeds and preserve their scope

### Feed and rule admission refuses an incomplete or oversize list

Selection compares feed ID, publisher/source label, license label and
license URL with the reviewed upstream metadata. Fetching requests the
selected public feed URL and sends no visited destination. Admit an OK
stream at most 24 MiB, a decoded domain list with at least 1,000 unique
valid hosts, and malformed lines at most one percent of its unique
domain count. Normalize lowercase labels and deduplicate. A saved list
timestamp must be finite and at most five minutes ahead. The reviewed
contract accepts a previously loaded list regardless of age.

A complete nonempty rule set has at most 1,200,000 domains. It uses
paired 2,000-domain chunks. The main-frame rule routes to the extension
warning page and subresource blocks use the paired rule. The extension
replaces only IDs in [10000, 12000). Never-block names are reviewed,
canonical, and at most 100 before dedupe. A reviewed hostname exception
covers whole DNS-label descendants. The Effect port validates syntax
and complete Chromium rule serialization before applying the rule update.

```quint
pure def admitsFeed(ok: bool, bytes: int, uniqueDomains: int, invalidLines: int): bool =
  ok and bytes >= 0 and bytes <= 25165824 and uniqueDomains >= 1000 and invalidLines >= 0 and invalidLines * 100 <= uniqueDomains
pure def savedFeedClock(finite: bool, recorded: int, now: int): bool =
  finite and recorded <= now + 300000
pure def ruleSupplyAdmitted(extensionExact: bool, warningPageValid: bool, hostsValid: bool, uniqueDomains: int, exceptionCount: int): bool =
  extensionExact and warningPageValid and hostsValid and uniqueDomains > 0 and uniqueDomains <= 1200000 and exceptionCount >= 0 and exceptionCount <= 100
pure def ownsDynamicRule(id: int): bool = id >= 10000 and id < 12000
pure def lawOversizeFeedRefused(ok: bool, bytes: int, uniqueDomains: int, invalidLines: int): bool =
  bytes > 25165824 implies not(admitsFeed(ok, bytes, uniqueDomains, invalidLines))
pure def lawReadyListDoesNotAgeOut(recorded: int, now: int): bool =
  recorded <= now implies savedFeedClock(true, recorded, now)
pure def lawProtectionCannotReplaceOtherRule(id: int): bool =
  (id < 10000 or id >= 12000) implies not(ownsDynamicRule(id))
```

### A temporary exception matches only the reviewed tab and exact HTTP request

The exception accepts a decoded HTTP or HTTPS address without credentials,
at most 800 serialized units, and a valid nonnegative tab ID. Clear the URL
fragment and quote the canonical address exactly for matching. Chromium's
exception applies only to the exact case-sensitive URL, the reviewed tab,
and a top-level GET. It has no authority to allow another resource type,
method, address, or tab. The requesting shell remains responsible for
transport and user review.

```quint
pure def exceptionAdmitted(webScheme: bool, hasCredentials: bool, urlUnits: int, tabId: int): bool =
  webScheme and not(hasCredentials) and urlUnits >= 0 and urlUnits <= 800 and tabId >= 0
pure def exceptionMatches(requestTab: int, reviewedTab: int, exactUrl: bool, topLevel: bool, getRequest: bool): bool =
  requestTab == reviewedTab and exactUrl and topLevel and getRequest
pure def lawExceptionKeepsTab(requestTab: int, reviewedTab: int, exactUrl: bool, topLevel: bool, getRequest: bool): bool =
  exceptionMatches(requestTab, reviewedTab, exactUrl, topLevel, getRequest) implies requestTab == reviewedTab
pure def lawExceptionRefusesOtherRequest(requestTab: int, reviewedTab: int, exactUrl: bool, topLevel: bool, getRequest: bool): bool =
  (not(exactUrl) or not(topLevel) or not(getRequest)) implies not(exceptionMatches(requestTab, reviewedTab, exactUrl, topLevel, getRequest))
```

## Story: Check a site against the feed snapshots the native host has loaded

### A hit blocks and missing snapshots remain visible

The native `reputation.mjs` loader requires one to eight distinct reviewed
feed IDs. Cache admission checks version, source URL, body size, timestamp,
and digest. Per-feed refresh is single-flight. A refresh failure retains a
valid snapshot and waits one minute before retry. Six hours controls
refresh eligibility, while any loaded snapshot remains usable. The
consumer chooses whether to wait for initial refresh. Match the normalized
host and its whole-label ancestors in configured feed order. A match in
any loaded feed blocks even when another feed is unavailable. A check
with one usable feed and no match reports no known threat. With none
it reports feed unavailable. Invalid and local addresses have distinct
outcomes. The decision models the lookup after the configured waits.
Cache I/O and match evidence are refined at the Effect boundary.

```quint
type ReputationResult = InvalidReputationAddress | LocalReputationAddress | ReputationUnavailable | ReputationBlocked | NoKnownThreat
pure def reputationDecision(validAddress: bool, publicHost: bool, anyUsableFeed: bool, matchingFeed: bool): ReputationResult =
  if (not(validAddress)) InvalidReputationAddress
  else if (not(publicHost)) LocalReputationAddress
  else if (not(anyUsableFeed)) ReputationUnavailable
  else if (matchingFeed) ReputationBlocked else NoKnownThreat
pure def canRefreshFeed(stopped: bool, inProgress: bool, retryAfter: int, now: int): bool =
  not(stopped or inProgress) and now >= retryAfter
pure def lawNoLoadedFeedIsUnavailable(validAddress: bool, publicHost: bool, matchingFeed: bool): bool =
  (validAddress and publicHost) implies reputationDecision(validAddress, publicHost, false, matchingFeed) == ReputationUnavailable
pure def lawAnyLoadedMatchBlocks(validAddress: bool, publicHost: bool): bool =
  (validAddress and publicHost) implies reputationDecision(validAddress, publicHost, true, true) == ReputationBlocked
```
