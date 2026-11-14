# Alpha Inbox saved reads and cache custody

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` calls the
Eliza gitlink `c518127a025ab173874af9c7d304f26b25213b0d` mailbox helpers
in `plugins/plugin-inbox/src/mailbox/{mailbox-list,grants}.ts`.
The renderer owns when a cached read may be used. Its references
are `apps/app/src/prototype/inbox-cloud-adapter.ts` and
`apps/app/src/runtime/{gmail-mailbox,gmail-account-selection,service-read-cache,service-read-cache-store}.ts`.
This contract refines cache behavior after a mailbox read. Provider
paging, grant issuance, draft custody and reviewed operations have
their own specifications. A saved read supplies no provider authority.

## Story: Resume my own mailbox and recheck its access

### Keep cached results under the current Cloud and Gmail identities

In memory, list and body keys encode four JSON array elements. They
are Cloud session, credential ID, selected Gmail connection ID, and
the exact full query or message ID respectively. The preview read
key has session, connection and literal `google.gmail.triage`. It
exists only when the account is connected and readable. The account
choice hint uses environment, user and organization or empty string.
It holds an optional ID of 1–256 UTF-16 units with no whitespace.
The hint can guide selection and one speculative read.

Inbox discovery keeps the current account if still readable, else
uses a readable hint, else the first readable provider row. Home
warmup uses the hint when present and readable, or chooses only if
exactly one account is readable and the hint is absent. An unverified
hint grants no right by itself. Account switch clears list and body
maps, serves no previous message or preview, pauses or invalidates
read-ahead, cancels stale body and attachment work, advances the
cache epoch, and requests null snapshots for the opened Gmail cache.
Current read identity loss also invalidates the caches. A withdrawn
modify-only capability can retire pending operations while a still
identical read key retains existing mail. Another Gmail account's
disconnect does not purge the selected account if account discovery
reconfirms its readable key. When rechecking the selected account,
missing or unavailable account discovery fails closed. A confirmed
revocation suppresses Home saved restoration even when storage clear
rejects or exhausts compare-and-exchange retries.

```quint
type MailReadKey = { session: str, credential: str, account: str, keyPart: str }
type GrantRead = { session: str, account: str, readable: bool }
pure def sameCacheKey(left: MailReadKey, right: MailReadKey): bool =
  left.session == right.session and left.credential == right.credential and left.account == right.account and left.keyPart == right.keyPart
pure def liveReadKey(grant: GrantRead): bool =
  grant.session != "" and grant.account != "" and grant.readable
pure def grantKeepsCache(prior: GrantRead, nextGrant: GrantRead): bool =
  liveReadKey(prior) and liveReadKey(nextGrant) and prior.session == nextGrant.session and prior.account == nextGrant.account
pure def droppedRead(prior: GrantRead, nextGrant: GrantRead, previousSelection: str, nextSelection: str): bool =
  previousSelection != nextSelection or (previousSelection != "" and not(grantKeepsCache(prior, nextGrant)))
pure def inboxChoice(currentReadable: str, hintReadable: str, firstReadable: str): str =
  if (currentReadable != "") currentReadable else if (hintReadable != "") hintReadable else firstReadable
pure def homeChoice(hint: str, hintReadable: str, firstReadable: str, readableCount: int): str =
  if (hint != "") hintReadable else if (readableCount == 1) firstReadable else ""
pure def lawForeignCacheKey(left: MailReadKey, right: MailReadKey): bool =
  (left.account != right.account or left.credential != right.credential or left.session != right.session) implies not(sameCacheKey(left, right))
pure def lawRevokedReadDropsCache(prior: GrantRead, nextGrant: GrantRead, previousSelection: str, nextSelection: str): bool =
  previousSelection != "" and not(nextGrant.readable) implies droppedRead(prior, nextGrant, previousSelection, nextSelection)
pure def lawHomeNeedsSingleAccountWithoutHint(hint: str, hintReadable: str, firstReadable: str, readableCount: int): bool =
  hint == "" and readableCount != 1 implies homeChoice(hint, hintReadable, firstReadable, readableCount) == ""
pure val leftValues = Set(
  { session: "s", credential: "c", account: "a", keyPart: "in:inbox" },
  { session: "s", credential: "c", account: "b", keyPart: "in:inbox" },
  { session: "t", credential: "d", account: "a", keyPart: "m" })
pure val rightValues = leftValues
pure val priorValues = Set(
  { session: "s", account: "a", readable: true },
  { session: "s", account: "a", readable: false },
  { session: "t", account: "b", readable: true })
pure val nextGrantValues = priorValues
```

### Fence disk restores against a newer result and revocation

The disk restore captures renderer generation, mail-cache epoch,
Home-summary epoch, Cloud client and session. After reading both
snapshots it rechecks these values, plus the owner when opening
the store. Inbox restore needs the view active. Home startup needs
a mounted shell, no selected mailbox and an inactive Inbox view.
Home takes one saved-restore attempt per owner and session unless
invalidated and refuses a restore once it has seen revocation.
A Home network summary advances the summary epoch and prevents
the earlier saved reply from replacing it. The separate save paths
also recheck captured epoch and selected account for full mail,
or current Home request, choice hint and summary epoch for Home.

Inbox marks restored accounts as from disk and always rediscovers
provider accounts, including when the cached list is younger than
one minute. It may show the saved page while discovery or refresh
is pending. A transient read failure can retain that page. Only an
already-live Home preview in the matching owner, session, grant and
Inbox query, less than 60 seconds old and backed by a restorable
list, skips rediscovery on open. With no such preview, an un-restored
Inbox, disk accounts, or list age at least 60 seconds triggers
account refresh. Folder switches restore the selected query if
available and refresh it at 60 seconds. Body open may display a
cached body at age under 30 days and skip its read under 300 seconds.
The body comparison uses elapsed subtraction only, so a finite
future body time formally passes these checks. This asymmetric
compatibility behavior is separate from the list and outer document
checks, which reject future timestamps.

```quint
type RestoreSurface = HomeRestore | InboxRestore
type RestoreFence = { generation: int, cacheEpoch: int, summaryEpoch: int, client: int, session: int, owner: int }
pure def matchesFence(captured: RestoreFence, active: RestoreFence): bool =
  captured.generation == active.generation and captured.cacheEpoch == active.cacheEpoch and captured.summaryEpoch == active.summaryEpoch and
  captured.client == active.client and captured.session == active.session and captured.owner == active.owner
pure def restoreAllowed(surface: RestoreSurface, captured: RestoreFence, active: RestoreFence, inboxActive: bool, mounted: bool, hasSelected: bool, revoked: bool): bool =
  matchesFence(captured, active) and active.owner > 0 and active.client > 0 and active.session > 0 and
  (if (surface == InboxRestore) inboxActive else mounted and not(inboxActive) and not(hasSelected) and not(revoked))
pure def freshSaved(at: int, now: int): bool = at <= now and now - at < 2592000000
pure def bodyCanShow(at: int, now: int): bool = now - at < 2592000000
pure def bodySkipsRead(at: int, now: int): bool = now - at < 300000
pure def needsDiscovery(restored: bool, accountsFromDisk: bool, age: int): bool =
  not(restored) or accountsFromDisk or age >= 60000
pure def lawNewSummaryRetiresRestore(surface: RestoreSurface, captured: RestoreFence, active: RestoreFence, inboxActive: bool, mounted: bool, hasSelected: bool, revoked: bool): bool =
  active.summaryEpoch != captured.summaryEpoch implies not(restoreAllowed(surface, captured, active, inboxActive, mounted, hasSelected, revoked))
pure def lawHomeWithholdsKnownRevocation(captured: RestoreFence, active: RestoreFence, inboxActive: bool, mounted: bool, hasSelected: bool): bool =
  not(restoreAllowed(HomeRestore, captured, active, inboxActive, mounted, hasSelected, true))
pure def fullSaveAllowed(accountsChecked: bool, selected: str, failedRead: bool, capturedEpoch: int, activeEpoch: int, capturedSelection: str): bool =
  accountsChecked and selected != "" and not(failedRead) and capturedEpoch == activeEpoch and capturedSelection == selected
pure def lawLateSnapshotCannotReplaceSelection(accountsChecked: bool, selected: str, failedRead: bool, capturedEpoch: int, activeEpoch: int, capturedSelection: str): bool =
  capturedSelection != selected or capturedEpoch != activeEpoch implies
  not(fullSaveAllowed(accountsChecked, selected, failedRead, capturedEpoch, activeEpoch, capturedSelection))
pure def lawDiskAlwaysRechecks(restored: bool, age: int): bool =
  needsDiscovery(restored, true, age)
pure def lawFutureListsUnavailable(at: int, now: int): bool =
  at > now implies not(freshSaved(at, now))
pure def lawBodyFreshnessImpliesDisplay(at: int, now: int): bool =
  bodySkipsRead(at, now) implies bodyCanShow(at, now)
pure val capturedValues = Set(
  { generation: 1, cacheEpoch: 1, summaryEpoch: 1, client: 1, session: 1, owner: 1 },
  { generation: 1, cacheEpoch: 1, summaryEpoch: 2, client: 1, session: 1, owner: 1 },
  { generation: 1, cacheEpoch: 2, summaryEpoch: 1, client: 2, session: 2, owner: 2 })
pure val activeValues = capturedValues
pure val ageValues = Set(-1, 0, 59999, 60000, 300000, 2592000000)
pure val atValues = Set(0, 1, 1000, 2000, 2592000000)
pure val nowValues = atValues
```

## Story: Recover what the last successful read actually saved

### Decode the full saved mailbox and Home summary at their distinct boundaries

The full saved mailbox needs a non-array object, accounts, lists
and bodies arrays, a string selection, and no conflict with a
nonempty hint. Every account row has a string label and a
capabilities array. Find the first connected readable row whose
connection ID equals the selected ID. Lists survive the decoder
when query is string, timestamp is number, messages are an array,
and every message has string ID, from and snippet and array to.
Bodies survive when time is number and body contains a nonempty
string message ID and string bodyText. Invalid rows are dropped.
The decoder recognizes the spam/trash flag only when strictly true.
It neither validates optional list fields nor bounds row count,
finite time or body size. The exact disk parser accepts those values
at this intermediate boundary. Rebinding and later reads still
check their own bounds. Missing cursor history, opaque body fields
and other legacy values can reach the restore attempt. Do not widen
this shallow parser into evidence that every returned value is safe
for arbitrary rendering or operations.

Home only needs accounts and lists arrays, a compatible hint and a
readable selected account. Malformed sibling account rows are
ignored. Within each snapshot, choose the newest fresh `in:inbox`
list before validating its payload. If that candidate is invalid,
the snapshot yields no summary, even if it has an older valid
list. The chosen list needs at most 100 messages and a null or
string cursor. Each message needs string ID, subject and sender
and a Boolean unread flag. Project only those four fields locally.
Use cursor non-null for more and retain the actual list timestamp.
The adapter then chooses the newest valid summary across full
mail and Home snapshots, stable with mailbox first on ties.
Home attention contributes count, more, account label and time.

For full Inbox restore, choose the snapshot with the highest
current-query timestamp, with a zero floor and full-mail first on
ties. Merge only decoded snapshots with the same selected ID and
current-session readable-grant key. Sort source rows oldest first.
Regenerate list keys from current session, credential, chosen ID and
decoded query, and body keys from the chosen ID and decoded message
ID. Saved keys are unused when restoring. Within this document
ownership the payload is trusted to have been written for its
stated selection. A writer with access to the owner document can
forge payload association, since message rows carry no independently
checked account tag. The model represents normalized object and
field-type observations at this boundary.

```quint
type EnvelopeFacts = { hasShape: bool, accountsArray: bool, listsArray: bool, bodiesArray: bool, allAccountsShaped: bool, selectedIsString: bool, hintMatches: bool, readableSelected: bool }
type MessageFacts = { idString: bool, fromString: bool, snippetString: bool, toArray: bool, subjectString: bool, unreadBoolean: bool }
type HomeListFacts = { queryInbox: bool, at: int, finiteTime: bool, hasListShape: bool, messagesArray: bool, messagesWellTyped: bool, messageCount: int, cursorValid: bool }
pure def fullMailboxDecoded(wire: EnvelopeFacts): bool =
  wire.hasShape and wire.accountsArray and wire.listsArray and wire.bodiesArray and wire.allAccountsShaped and
  wire.selectedIsString and wire.hintMatches and wire.readableSelected
pure def homeMailboxDecoded(wire: EnvelopeFacts): bool =
  wire.hasShape and wire.accountsArray and wire.listsArray and wire.hintMatches and wire.readableSelected
pure def fullSavedMessage(msg: MessageFacts): bool = msg.idString and msg.fromString and msg.snippetString and msg.toArray
pure def homeSavedMessage(msg: MessageFacts): bool = msg.idString and msg.fromString and msg.subjectString and msg.unreadBoolean
pure def fullSavedList(shaped: bool, queryString: bool, numericTime: bool, messagesArray: bool, messagesWellTyped: bool): bool =
  shaped and queryString and numericTime and messagesArray and messagesWellTyped
pure def fullSavedBody(shaped: bool, numericTime: bool, nonemptyMessageId: bool, bodyTextString: bool): bool =
  shaped and numericTime and nonemptyMessageId and bodyTextString
pure def homeListCandidate(row: HomeListFacts, now: int): bool =
  row.hasListShape and row.queryInbox and row.finiteTime and freshSaved(row.at, now)
pure def homeListValid(row: HomeListFacts): bool =
  row.messagesArray and row.messagesWellTyped and row.messageCount >= 0 and row.messageCount <= 100 and row.cursorValid
pure def secondHomeCandidate(firstHome: HomeListFacts, secondHome: HomeListFacts, now: int): bool =
  homeListCandidate(secondHome, now) and (not(homeListCandidate(firstHome, now)) or secondHome.at > firstHome.at)
pure def homeFromPair(firstHome: HomeListFacts, secondHome: HomeListFacts, now: int): bool =
  if (secondHomeCandidate(firstHome, secondHome, now)) homeListValid(secondHome)
  else homeListCandidate(firstHome, now) and homeListValid(firstHome)
pure def restoreCompatible(selected: str, otherSelected: str, matchingReadKey: bool): bool =
  selected == otherSelected and matchingReadKey
pure def preferOtherSnapshot(firstAge: int, otherAge: int): bool =
  otherAge > 0 and otherAge > firstAge
pure def lawBothDecodersBindHint(wire: EnvelopeFacts): bool =
  not(wire.hintMatches) implies not(fullMailboxDecoded(wire) or homeMailboxDecoded(wire))
pure def lawFullEnvelopeAlsoHomeEligible(wire: EnvelopeFacts): bool =
  fullMailboxDecoded(wire) implies homeMailboxDecoded(wire)
pure def lawBadNewestBlocksOlderWithinSnapshot(firstHome: HomeListFacts, secondHome: HomeListFacts, now: int): bool =
  secondHomeCandidate(firstHome, secondHome, now) and not(homeListValid(secondHome)) implies not(homeFromPair(firstHome, secondHome, now))
pure def lawCannotMergeAccounts(selected: str, otherSelected: str, matchingReadKey: bool): bool =
  selected != otherSelected implies not(restoreCompatible(selected, otherSelected, matchingReadKey))
pure val wireValues = Set(
  { hasShape: true, accountsArray: true, listsArray: true, bodiesArray: true, allAccountsShaped: true, selectedIsString: true, hintMatches: true, readableSelected: true },
  { hasShape: true, accountsArray: true, listsArray: true, bodiesArray: false, allAccountsShaped: false, selectedIsString: true, hintMatches: true, readableSelected: true },
  { hasShape: true, accountsArray: true, listsArray: true, bodiesArray: true, allAccountsShaped: true, selectedIsString: true, hintMatches: false, readableSelected: true })
pure val msgValues = Set(
  { idString: true, fromString: true, snippetString: true, toArray: true, subjectString: false, unreadBoolean: false },
  { idString: true, fromString: true, snippetString: false, toArray: false, subjectString: true, unreadBoolean: true })
pure val firstHomeValues = Set(
  { queryInbox: true, at: 0, finiteTime: true, hasListShape: true, messagesArray: true, messagesWellTyped: true, messageCount: 100, cursorValid: true },
  { queryInbox: true, at: 1, finiteTime: true, hasListShape: true, messagesArray: true, messagesWellTyped: true, messageCount: 101, cursorValid: true },
  { queryInbox: false, at: 2, finiteTime: true, hasListShape: true, messagesArray: true, messagesWellTyped: true, messageCount: 1, cursorValid: true })
pure val secondHomeValues = firstHomeValues
pure val rowValues = firstHomeValues
```

### Evict the oldest memory entries and keep the newest full bodies that fit

List remember rejects an empty query, the exact drafts query and
over 100 messages. Remember clones the messages and cursor arrays
and inserts at the newest end, replacing its old key position.
List restore put also replaces and moves to newest, skips remember
admission, and still enforces eight entries. A hit does not promote.
A stale, future or nonfinite list time makes get remove only that
entry. Already decoded lists can be put without age filtering.

Body remember replaces the key at the newest end then evicts the
oldest entries until at most 16 remain and total UTF-8 JSON bytes
of their bodies are at most four MiB. If a remembered body alone
exceeds the limit, the already-evicted earlier bodies stay evicted.
Body put during restore moves the key to the newest end and uses
the original time, with no memory count or byte eviction on that
path. Body get neither promotes nor checks time. Persisted body
selection keeps the newest contiguous suffix fitting two MiB of
body JSON, restores its original oldest-first order, and stops at
the first row that would exceed budget. An oversized newest body
means that snapshot saves no bodies. The document size is checked
separately. A body carrying a loading flag is skipped by the
renderer before memory admission.

Only lists under the selected connection ID are saved. Body
persistence relies on clearing body state at selection or read
identity changes and does not independently filter by account.
A model list in this block is ordered newest first. Byte measures
exclude metadata when applied to memory and to the snapshot body
selection. They represent the actual UTF-8 bytes from JSON, not
string-unit length.

```quint
type CacheItem = { key: str, bytes: int }
type SuffixBudget = { open: bool, count: int, cost: int, kept: List[CacheItem] }
pure val emptyBudget: SuffixBudget = { open: true, count: 0, cost: 0, kept: List() }
pure def listRememberAllowed(query: str, messageCount: int): bool =
  query != "" and query != "in:drafts" and messageCount >= 0 and messageCount <= 100
pure def appendItem(kept: List[CacheItem], entry: CacheItem): List[CacheItem] = kept.append(entry)
pure def admitItem(budget: SuffixBudget, entry: CacheItem, maxCount: int, maxBytes: int): SuffixBudget =
  if (budget.open and budget.count < maxCount and entry.bytes >= 0 and budget.cost + entry.bytes <= maxBytes)
    { open: true, count: budget.count + 1, cost: budget.cost + entry.bytes, kept: appendItem(budget.kept, entry) }
  else { ...budget, open: false }
pure def retainLatest(newest: List[CacheItem], maxCount: int, maxBytes: int): SuffixBudget =
  newest.foldl(emptyBudget, (budget, entry) => admitItem(budget, entry, maxCount, maxBytes))
pure def latestReplace(newest: List[CacheItem], entry: CacheItem): List[CacheItem] =
  newest.foldl(List(entry), (kept, oldEntry) =>
    if (oldEntry.key == entry.key) kept else appendItem(kept, oldEntry))
pure def rememberBodyItems(newest: List[CacheItem], entry: CacheItem): SuffixBudget =
  retainLatest(latestReplace(newest, entry), 16, 4194304)
pure def persistBodyItems(newest: List[CacheItem]): SuffixBudget =
  retainLatest(newest, newest.length(), 2097152)
pure def savedBodyPut(newest: List[CacheItem], entry: CacheItem): List[CacheItem] =
  latestReplace(newest, entry)
pure def lawListRejectsDrafts(messageCount: int): bool =
  not(listRememberAllowed("in:drafts", messageCount))
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
pure val keptValues = newestValues
pure val budgetValues = Set(emptyBudget, { open: true, count: 1, cost: 2, kept: List({ key: "a", bytes: 2 }) },
  { open: false, count: 1, cost: 2, kept: List({ key: "a", bytes: 2 }) })
pure val maxCountValues = Set(0, 1, 8, 16, 24)
pure val maxBytesValues = Set(0, 2000000, 2097152, 4194304)
pure val messageCountValues = Set(0, 1, 100, 101)
```

### Persist Gmail in its own compare-and-exchange document

The cache document identity encodes environment, owner user,
organization and credential ID. Gmail adds the service literal
`gmail`. All four owner components must be nonempty strings up to
1,024 UTF-16 units. The platform hashes the JSON tuple with SHA-256
and uses `connected-read-cache:v1:` plus the digest, with the
`alpha.browser.` prefix in browser storage. Native uses the
encrypted connection slots. Browser structurally compares stored
and expected JSON inside the document edit. Owner identity and
service scope separate Gmail from the account-level Calendar
document. Opening Gmail schedules retirement of the two legacy
mail keys from the shared account document once per account per
process. The operation reads each key and writes null if non-null.
It never migrates legacy mail or retires the other entries. A
failure permits a later attempt.

The service uses `{ version: 1, owner, entries }`. A missing value
means empty. A read enforces exact owner and version, entries array,
at most 24 entries and a four MiB encoded-document bound, then
filters entries with string keys shorter than 16,384 UTF-16 units
and finite timestamps between now minus 30 days and now,
exclusive at the older side. An exact key lookup returns the
first surviving matching entry. The decoder assumes row objects
on the entry filter path. A null entry can fail the read rather
than being filtered. The adapter handles optional store failures.

A put refuses an oversized encoded entry or long key, then queues
under the current cache epoch. Each of at most three attempts
rereads the storage, replaces the exact key, orders ascending
by time with stable ties, and evicts the oldest entries until
the count and total size fit. The encoded size includes the
document envelope and per-entry commas. Before CAS the put checks
that its epoch remains current. Clear advances the epoch before
queuing and attempts CAS to null up to three times. A stale get
returns no content if its read finishes after epoch retirement.
The epoch does not cancel an already-started CAS. Clear remains
queued after it, and an exhausted clear does not prove deletion.

```quint
type CacheDocument = { expectedOwner: bool, versionOne: bool, entriesArray: bool, entryCount: int, documentBytes: int }
pure def documentAvailable(doc: CacheDocument): bool =
  doc.expectedOwner and doc.versionOne and doc.entriesArray and doc.entryCount >= 0 and doc.entryCount <= 24 and
  doc.documentBytes >= 0 and doc.documentBytes <= 4194304
pure def validEntry(keyUnits: int, finiteTime: bool, at: int, now: int): bool =
  keyUnits >= 0 and keyUnits < 16384 and finiteTime and freshSaved(at, now)
pure def writeAdmitted(keyUnits: int, entryBytes: int): bool =
  keyUnits >= 0 and keyUnits < 16384 and entryBytes >= 0 and entryBytes <= 4194304
pure def belongsToSelected(listAccount: str, selected: str): bool =
  listAccount == selected
pure def lawForeignListIsNotSaved(listAccount: str, selected: str): bool =
  listAccount != selected implies not(belongsToSelected(listAccount, selected))
pure def documentSize(envelopeBytes: int, entriesBytes: int, entryCount: int): int =
  envelopeBytes + entriesBytes + (if (entryCount > 0) entryCount - 1 else 0)
pure def cacheEpochAllows(launchEpoch: int, currentEpoch: int): bool =
  launchEpoch == currentEpoch
pure def casRetry(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  attempt >= 1 and attempt < 3 and isConflict and cacheEpochAllows(launchEpoch, currentEpoch)
pure def sharedMailKey(key: str): bool = key == "gmail:mailbox" or key == "gmail:home"
pure def lawForeignDocumentUnavailable(doc: CacheDocument): bool =
  not(doc.expectedOwner) implies not(documentAvailable(doc))
pure def lawRetiredCacheCannotRetry(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  launchEpoch != currentEpoch implies not(casRetry(attempt, isConflict, launchEpoch, currentEpoch))
pure def lawThreeAttemptsAtMost(attempt: int, isConflict: bool, launchEpoch: int, currentEpoch: int): bool =
  attempt >= 3 implies not(casRetry(attempt, isConflict, launchEpoch, currentEpoch))
pure def lawLegacyRetirementPreservesCalendar(key: str): bool =
  key != "gmail:mailbox" and key != "gmail:home" implies not(sharedMailKey(key))
pure val docValues = Set(
  { expectedOwner: true, versionOne: true, entriesArray: true, entryCount: 24, documentBytes: 4194304 },
  { expectedOwner: false, versionOne: true, entriesArray: true, entryCount: 1, documentBytes: 16 },
  { expectedOwner: true, versionOne: true, entriesArray: true, entryCount: 25, documentBytes: 64 })
pure val keyValues = Set("gmail:mailbox", "gmail:home", "calendar:agenda", "")
pure val keyUnitsValues = Set(0, 1, 16383, 16384)
pure val attemptValues = Set(0, 1, 2, 3, 4)
```
