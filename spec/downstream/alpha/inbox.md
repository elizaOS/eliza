# Alpha's managed Inbox list and bodies

Alpha's `inbox-cloud-adapter.ts` imports `MailboxListCache`, `MailBodyCache`,
`mergeMailboxPage`, `nextMailboxCursor`, `readSavedMailbox`,
`readSavedInboxSummary`, `mailboxListStatus` and `inboxAttentionFor` from
Eliza `plugins/plugin-inbox/src/mailbox/mailbox-list.ts`. Alpha owns folder
presentation and owner/draft state. The connection owns the current
credential and managed Google envelope. Provider drafts and reviewed
sending are separate from cached list state.

## Story: Read my mailbox without mixing account pages or endlessly reusing a cursor

### Pages keep their first read's identity and expose mailbox shifts

A first page starts a fresh result with the provider's reported revision
when present. Later pages preserve first-page ordering, add only unseen
message IDs in response order, and mark drift if an ID repeats from the
existing list or if both provider revisions are present and differ.
A missing provider revision leaves repeat detection available. A missing
or already-seen next cursor ends pagination. Only the current
credential, folder, search and load attempt can adopt the page. A list
or body cache does not grant access or authorize sending a draft.
A missing connection or an empty folder cannot start a read.

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

### Cached reads respect owner, folder, provider identity and capacity

Saved mailbox reads validate shape and provider labels, and replay only
for a current connection key. The list cache expires per key and has a
bounded folder count. The body cache tracks both entry count and decoded
byte cost, refuses oversize bodies and refreshes insertion order when it remembers or restores an entry. Alpha's
adapter uses eight list entries with a 30-day horizon and sixteen bodies
with a four MiB byte bound. Actual persisted key serialization, byte
encoding, LRU ordering and the provider's body admission require a future
adapter and refinement test. Attachment rendering and sending do not read
credentials from cache state.

```quint
type SavedRead = { valid: bool, sameOwner: bool, sameFolder: bool, sameProvider: bool, age: int }
pure val savedValues = Set({ valid: true, sameOwner: true, sameFolder: true, sameProvider: true, age: 0 }, { valid: true, sameOwner: false, sameFolder: true, sameProvider: true, age: 0 }, { valid: true, sameOwner: true, sameFolder: true, sameProvider: true, age: 2592000001 })
pure def admissibleSavedList(saved: SavedRead): bool = saved.valid and saved.sameOwner and saved.sameFolder and saved.sameProvider and saved.age >= 0 and saved.age < 2592000000
pure def lawSavedListCannotCrossOwner(saved: SavedRead): bool = not(saved.sameOwner) implies not(admissibleSavedList(saved))
pure def fitsBodyCache(bytes: int): bool = bytes >= 0 and bytes <= 4194304
pure def lawOversizeBodyDoesNotFit(bytes: int): bool = bytes > 4194304 implies not(fitsBodyCache(bytes))
```
