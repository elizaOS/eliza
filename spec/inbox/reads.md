# Mailbox reads and caches

The inbox package reads the owner's mailbox page by page and keeps recent
lists and bodies in memory and on disk so a reopened inbox can show them
at once. A cached read never grants provider access and never authorizes
sending a draft. The connection owns the current credential and the
managed account route ([managed Gmail](../cloud/index.md)).
[Drafts](./drafts.md) and reviewed sending are separate from cached state,
and the [managed inbox read](./managedRead.md) is always fresh.

The linked cloud contracts are being rebuilt. Their detailed models and
execution evidence remain pending.

## Story: Read my mailbox without mixing account pages or endlessly reusing a cursor

> As the owner, I want each page of my mailbox to belong to the account,
> folder and search I asked for, and paging to end rather than loop.

### Pages keep their first read's identity and expose mailbox shifts

A first page starts a fresh result with the provider's reported revision
when present. Later pages preserve first-page ordering, add only unseen
message IDs in response order, and mark drift if an ID repeats from the
existing list or if both provider revisions are present and differ.
A missing provider revision leaves repeat detection available. A missing
or already-seen next cursor ends pagination. Only the current
credential, folder, search and load attempt can adopt the page. A
missing connection or an empty folder cannot start a read.

```quint
type MailboxQuery = { connection: int, folder: str, query: str }
type MailboxFeed = { key: MailboxQuery, load: int, messages: List[str], seen: List[str], history: str, cursor: str, shifted: bool }
type MailboxPage = { messages: List[str], providerHistory: str, nextCursor: str }
pure val emptyQuery: MailboxQuery = { connection: 0, folder: "", query: "" }
pure val initial: MailboxFeed = { key: emptyQuery, load: 0, messages: List(), seen: List(), history: "", cursor: "", shifted: false }
pure val queryValues = Set(emptyQuery, { connection: 1, folder: "inbox", query: "" }, { connection: 2, folder: "inbox", query: "" }, { connection: 1, folder: "sent", query: "term" })
pure val pageValues = Set({ messages: List("m1", "m2"), providerHistory: "a", nextCursor: "p1" }, { messages: List("m2", "m3", "m3"), providerHistory: "b", nextCursor: "p2" }, { messages: List("m4"), providerHistory: "a", nextCursor: "p1" }, { messages: List(), providerHistory: "", nextCursor: "" })
pure val pageTokenValues = Set("", "p1", "p2", "stale")
pure val receiptLoadValues = Set(1, 2, 3, 4, 5)
pure def canBegin(s: MailboxFeed, query: MailboxQuery): bool = query.connection > 0 and query.folder != ""
pure def begin(s: MailboxFeed, query: MailboxQuery): MailboxFeed = { ...initial, key: query, load: s.load + 1 }
pure def canAcceptPage(s: MailboxFeed, query: MailboxQuery, receiptLoad: int, pageToken: str): bool =
  s.key.connection > 0 and query == s.key and receiptLoad == s.load and (pageToken == "" or pageToken == s.cursor)
pure def uniqueAppend(prior: List[str], added: List[str]): List[str] =
  added.foldl(prior, (acc, id) => if (acc.includes(id)) acc else acc.append(id))
pure def acceptPage(s: MailboxFeed, query: MailboxQuery, receiptLoad: int, pageToken: str, page: MailboxPage): MailboxFeed = {
  val later = pageToken != ""
  val baseIds = if (later) s.messages else List()
  val baseCursors = if (later) s.seen else List()
  val repeated = later and page.messages.some(id => s.messages.includes(id))
  val historyChanged = later and s.history != "" and page.providerHistory != "" and s.history != page.providerHistory
  val newCursor = page.nextCursor != "" and not(baseCursors.includes(page.nextCursor))
  { ...s, messages: uniqueAppend(baseIds, page.messages), seen: if (newCursor) baseCursors.append(page.nextCursor) else baseCursors,
    cursor: if (newCursor) page.nextCursor else "", history: if (later) s.history else page.providerHistory, shifted: repeated or historyChanged }
}
pure def canDisconnect(s: MailboxFeed): bool = s.key.connection > 0
pure def disconnect(s: MailboxFeed): MailboxFeed = { ...initial, load: s.load + 1 }
pure def alwaysCursorWasObserved(s: MailboxFeed): bool = s.cursor == "" or s.seen.includes(s.cursor)
pure def alwaysUniqueMessages(s: MailboxFeed): bool = s.messages.every(id => s.messages.select(other => other == id).length() == 1)
pure def alwaysUniqueCursors(s: MailboxFeed): bool = s.seen.every(cursor => s.seen.select(other => other == cursor).length() == 1)
pure def alwaysDetachedMailboxEmpty(s: MailboxFeed): bool = s.key.connection != 0 or (s.messages.length() == 0 and s.cursor == "" and s.history == "")
pure def sometimesShifted(s: MailboxFeed): bool = s.shifted
pure def sometimesListHasNextPage(s: MailboxFeed): bool = s.cursor != ""
```

## Story: Resume my own mailbox from what was saved, and recheck its access

> As the owner, I want a reopened inbox to show what my last read saved,
> but only for the account I am signed in as and while it is still
> readable, so that no other account's mail ever appears.

### Cached reads are keyed by session, credential and account, and dropped on a switch or revocation

List and body entries are keyed by the session, the credential, the
selected account and the exact query or message. A read key exists only
while the account is connected and readable; an unverified account hint
grants no right by itself. Switching account, losing read identity or a
confirmed revocation drops both caches and serves no previous message;
another account's disconnect does not, once discovery reconfirms the
selected account's key. When the selected account cannot be rechecked,
the cache fails closed.

```quint
type MailReadKey = { session: str, credential: str, account: str, keyPart: str }
type GrantRead = { session: str, account: str, readable: bool }
pure def sameCacheKey(left: MailReadKey, right: MailReadKey): bool =
  left.session == right.session and left.credential == right.credential and left.account == right.account and left.keyPart == right.keyPart
pure def liveReadKey(grant: GrantRead): bool =
  grant.session != "" and grant.account != "" and grant.readable
pure def grantKeepsCache(priorGrant: GrantRead, nextGrant: GrantRead): bool =
  liveReadKey(priorGrant) and liveReadKey(nextGrant) and priorGrant.session == nextGrant.session and priorGrant.account == nextGrant.account
pure def droppedRead(priorGrant: GrantRead, nextGrant: GrantRead, previousSelection: str, nextSelection: str): bool =
  previousSelection != nextSelection or (previousSelection != "" and not(grantKeepsCache(priorGrant, nextGrant)))
pure def lawForeignCacheKey(left: MailReadKey, right: MailReadKey): bool =
  (left.account != right.account or left.credential != right.credential or left.session != right.session) implies not(sameCacheKey(left, right))
pure def lawRevokedReadDropsCache(priorGrant: GrantRead, nextGrant: GrantRead, previousSelection: str, nextSelection: str): bool =
  previousSelection != "" and not(nextGrant.readable) implies droppedRead(priorGrant, nextGrant, previousSelection, nextSelection)
pure val leftValues = Set(
  { session: "s", credential: "c", account: "a", keyPart: "in:inbox" },
  { session: "s", credential: "c", account: "b", keyPart: "in:inbox" },
  { session: "t", credential: "d", account: "a", keyPart: "m" })
pure val rightValues = leftValues
pure val priorGrantValues = Set(
  { session: "s", account: "a", readable: true },
  { session: "s", account: "a", readable: false },
  { session: "t", account: "b", readable: true })
pure val nextGrantValues = priorGrantValues
```

### A restore or save is fenced by its cache epoch and restores only the selected account's checked payload

A disk restore captures the view generation, the cache epoch, the client,
the session and the owner, and rechecks them after reading; a newer
result, an account switch or a known revocation retires it. A save
likewise needs its captured epoch and selection to be current, so a late
snapshot never replaces a newer selection, and a list read for another
account is never saved. Restored lists and bodies are merged only when
the snapshot's selection, its payload's checked account tag and the
current readable key all match. A saved list or body is fresh only when
its time is not in the future and is under thirty days old; a body under
five minutes old also skips its read, and is then always fresh enough to
show. Accounts restored from disk are always rediscovered; only an
account list read live in this session and under a minute old skips
rediscovery.

```quint
type RestoreFence = { generation: int, cacheEpoch: int, client: int, session: int, owner: int }
pure val freshForMs: int = 2592000000
pure def matchesFence(captured: RestoreFence, active: RestoreFence): bool =
  captured.generation == active.generation and captured.cacheEpoch == active.cacheEpoch and
  captured.client == active.client and captured.session == active.session and captured.owner == active.owner
pure def restoreAllowed(captured: RestoreFence, active: RestoreFence, viewActive: bool, revoked: bool): bool =
  matchesFence(captured, active) and active.owner > 0 and active.client > 0 and active.session > 0 and viewActive and not(revoked)
pure def restoreCompatible(selected: str, payloadAccount: str, matchingReadKey: bool): bool =
  selected != "" and payloadAccount == selected and matchingReadKey
pure def saveAllowed(selected: str, failedRead: bool, capturedEpoch: int, activeEpoch: int, capturedSelection: str, listAccount: str): bool =
  selected != "" and not(failedRead) and capturedEpoch == activeEpoch and capturedSelection == selected and listAccount == selected
pure def freshSaved(at: int, now: int): bool = at <= now and now - at < freshForMs
pure def bodySkipsRead(at: int, now: int): bool = at <= now and now - at < 300000
pure def needsDiscovery(accountsFromDisk: bool, accountListAge: int): bool = accountsFromDisk or accountListAge < 0 or accountListAge >= 60000
pure def lawNewerEpochRetiresRestore(captured: RestoreFence, active: RestoreFence, viewActive: bool, revoked: bool): bool =
  active.cacheEpoch != captured.cacheEpoch implies not(restoreAllowed(captured, active, viewActive, revoked))
pure def lawRevokedRestoreWithheld(captured: RestoreFence, active: RestoreFence, viewActive: bool): bool =
  not(restoreAllowed(captured, active, viewActive, true))
pure def lawCannotMergeAccounts(selected: str, payloadAccount: str, matchingReadKey: bool): bool =
  payloadAccount != selected implies not(restoreCompatible(selected, payloadAccount, matchingReadKey))
pure def lawLateSnapshotCannotReplaceSelection(selected: str, failedRead: bool, capturedEpoch: int, activeEpoch: int, capturedSelection: str, listAccount: str): bool =
  capturedSelection != selected or capturedEpoch != activeEpoch implies not(saveAllowed(selected, failedRead, capturedEpoch, activeEpoch, capturedSelection, listAccount))
pure def lawForeignListIsNotSaved(selected: str, failedRead: bool, capturedEpoch: int, activeEpoch: int, capturedSelection: str, listAccount: str): bool =
  listAccount != selected implies not(saveAllowed(selected, failedRead, capturedEpoch, activeEpoch, capturedSelection, listAccount))
pure def lawFutureSavesUnavailable(at: int, now: int): bool = at > now implies not(freshSaved(at, now))
pure def lawBodyFreshnessImpliesDisplay(at: int, now: int): bool = bodySkipsRead(at, now) implies freshSaved(at, now)
pure def lawDiskAccountsAlwaysRediscovered(accountListAge: int): bool = needsDiscovery(true, accountListAge)
pure def lawOldAccountListRediscovered(accountsFromDisk: bool, accountListAge: int): bool =
  accountListAge >= 60000 implies needsDiscovery(accountsFromDisk, accountListAge)
pure val capturedValues = Set(
  { generation: 1, cacheEpoch: 1, client: 1, session: 1, owner: 1 },
  { generation: 1, cacheEpoch: 2, client: 1, session: 1, owner: 1 },
  { generation: 1, cacheEpoch: 2, client: 2, session: 2, owner: 2 })
pure val activeValues = capturedValues
pure val atValues = Set(0, 1, 1000, 2000, 2592000000)
pure val nowValues = Set(0, 1000, 2592000001)
pure val accountListAgeValues = Set(-1, 0, 59999, 60000)
```

### The saved document belongs to one owner, and its writes stop once their cache epoch retires

The saved mail document is named by the owner, organization and
credential, and is unavailable unless its owner matches, its version is
known, and it holds at most 24 entries and four MiB. A save or clear runs
under the cache epoch current when it was queued, and is a
compare-and-exchange of at most three attempts; it retries only on a
conflict while that epoch is still current, so a clear retires every
earlier save. A clear whose writes did not land proves nothing was
deleted.

```quint
type CacheDocument = { expectedOwner: bool, versionOne: bool, entryCount: int, documentBytes: int }
pure def documentAvailable(doc: CacheDocument): bool =
  doc.expectedOwner and doc.versionOne and doc.entryCount >= 0 and doc.entryCount <= 24 and doc.documentBytes >= 0 and doc.documentBytes <= 4194304
pure def casRetry(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  attempt >= 1 and attempt < 3 and isConflict and launchEpoch == currentEpoch
pure def clearProvesDeletion(attempt: int, nullWritten: bool): bool = nullWritten and attempt >= 1 and attempt <= 3
pure def lawForeignDocumentUnavailable(doc: CacheDocument): bool = not(doc.expectedOwner) implies not(documentAvailable(doc))
pure def lawRetiredCacheCannotRetry(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  launchEpoch != currentEpoch implies not(casRetry(attempt, isConflict, launchEpoch, currentEpoch))
pure def lawThreeAttemptsAtMost(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  attempt >= 3 implies not(casRetry(attempt, isConflict, launchEpoch, currentEpoch))
pure def lawFailedClearProvesNothing(attempt: int): bool = not(clearProvesDeletion(attempt, false))
pure val docValues = Set(
  { expectedOwner: true, versionOne: true, entryCount: 24, documentBytes: 4194304 },
  { expectedOwner: false, versionOne: true, entryCount: 1, documentBytes: 16 },
  { expectedOwner: true, versionOne: true, entryCount: 25, documentBytes: 64 })
pure val attemptValues = Set(0, 1, 2, 3, 4)
```

### The caches are bounded and evict their oldest entries first

A list is remembered only for a nonempty query other than drafts and at
most 100 messages. The list cache keeps the newest eight lists, evicting
the oldest first. The body cache keeps the newest bodies, at most
sixteen and four MiB of body bytes, evicting the oldest first; a body that
alone exceeds the bound is not kept, and older bodies already evicted stay
evicted.

```quint
type CacheItem = { key: str, bytes: int }
type SuffixBudget = { open: bool, count: int, cost: int, kept: List[CacheItem] }
pure val maxLists: int = 8
pure val maxBodies: int = 16
pure val maxBodyBytes: int = 4194304
pure val emptyBudget: SuffixBudget = { open: true, count: 0, cost: 0, kept: List() }
pure def listRememberAllowed(listQuery: str, messageCount: int): bool =
  listQuery != "" and listQuery != "in:drafts" and messageCount >= 0 and messageCount <= 100
pure def admitItem(budget: SuffixBudget, entry: CacheItem, maxCount: int, maxBytes: int): SuffixBudget =
  if (budget.open and budget.count < maxCount and entry.bytes >= 0 and budget.cost + entry.bytes <= maxBytes)
    { open: true, count: budget.count + 1, cost: budget.cost + entry.bytes, kept: budget.kept.append(entry) }
  else { ...budget, open: false }
pure def retainLatest(newest: List[CacheItem], maxCount: int, maxBytes: int): SuffixBudget =
  newest.foldl(emptyBudget, (budget, entry) => admitItem(budget, entry, maxCount, maxBytes))
pure def latestReplace(newest: List[CacheItem], entry: CacheItem): List[CacheItem] =
  newest.foldl(List(entry), (kept, oldEntry) => if (oldEntry.key == entry.key) kept else kept.append(oldEntry))
pure def rememberBodyItems(newest: List[CacheItem], entry: CacheItem): SuffixBudget =
  retainLatest(latestReplace(newest, entry), maxBodies, maxBodyBytes)
pure def rememberListItems(newest: List[CacheItem], entry: CacheItem): SuffixBudget =
  retainLatest(latestReplace(newest, { ...entry, bytes: 0 }), maxLists, 0)
pure def lawListRejectsDrafts(messageCount: int): bool = not(listRememberAllowed("in:drafts", messageCount))
pure def lawBudgetClosesWithoutOlderBody(budget: SuffixBudget, entry: CacheItem, maxCount: int, maxBytes: int): bool =
  not(budget.open) implies
    (not(admitItem(budget, entry, maxCount, maxBytes).open) and admitItem(budget, entry, maxCount, maxBytes).count == budget.count and
    admitItem(budget, entry, maxCount, maxBytes).cost == budget.cost)
pure def lawBodyAdmissionPreservesBounds(budget: SuffixBudget, entry: CacheItem, maxCount: int, maxBytes: int): bool =
  budget.cost >= 0 and budget.cost <= maxBytes and budget.count >= 0 and budget.count <= maxCount and entry.bytes >= 0 implies
  (admitItem(budget, entry, maxCount, maxBytes).cost >= 0 and admitItem(budget, entry, maxCount, maxBytes).cost <= maxBytes and
   admitItem(budget, entry, maxCount, maxBytes).count >= 0 and admitItem(budget, entry, maxCount, maxBytes).count <= maxCount)
pure def lawOversizeNewestStartsEmpty(entry: CacheItem, maxCount: int, maxBytes: int): bool =
  entry.bytes > maxBytes implies not(admitItem(emptyBudget, entry, maxCount, maxBytes).open) and
    admitItem(emptyBudget, entry, maxCount, maxBytes).count == 0
pure val entryValues = Set({ key: "a", bytes: 0 }, { key: "b", bytes: 2000000 }, { key: "a", bytes: 4500000 })
pure val newestValues = Set(List(), List({ key: "a", bytes: 0 }, { key: "b", bytes: 4500000 }))
pure val budgetValues = Set(emptyBudget, { open: true, count: 1, cost: 2, kept: List({ key: "a", bytes: 2 }) },
  { open: false, count: 1, cost: 2, kept: List({ key: "a", bytes: 2 }) })
pure val maxCountValues = Set(0, 1, 8, 16)
pure val maxBytesValues = Set(0, 2000000, 4194304)
pure val messageCountValues = Set(0, 1, 100, 101)
```
