# Grace saved payment receipt lookup

Grace's configured bill helper reaches Eliza
`7743504b7c936a764b3938a44cad918808b621df` through
`bill-helper-host.mjs`, `bill-workflow.mjs`, `bill-outcome-store.mjs`
and `bill-source-discovery.mjs` in the personal-assistant plugin.
The pinned app `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` shows the
email receipt line in `BillTaskPanel.tsx`. [Bill review](./billReview.md)
owns the payment outcome. [Bill source selection](./billSource.md)
owns the authorized mailbox context. This contract covers the
post-outcome, read-only receipt check through the configured path.

## Story: See that a receipt is in my email after an exact match

### A saved outcome reserves one durable lookup within its task budget

A workflow looks only for an outcome marked saved with a string
provider reference and the configured finder and check store. Load
the check for the exact task and owner. A missing row has zero
checks. A stored row needs a Boolean found flag, positive safe
integer count and a safe integer timestamp. A found row ends
searches. At most three searches are reserved, one minute apart
on the host clock. The workflow checks the elapsed time before
asking the store. The store's conditional SQL write rechecks the
owner, found state, count and timestamp for an existing row. The
first row starts at one. Its commit precedes the provider read.
A concurrent loser or failed reservation sends no query.

A failed read, missing match, cancellation or refused confirmation
leaves the reservation spent. Closing or reopening the caller
continues from the stored rows. The configured workflow adds
`receiptInEmail: true` only from a found row. A positive finder
answer must be persisted before it can supply that row. The saved
outcome stays intact while the optional search runs. Within one
outcome, two searches can overlap if a minute elapses while the
older provider read is still running. A late result that remains
authorized and exactly matches can still confirm that outcome.
The model uses reservation count as the local lookup identity.

```quint
type ReceiptCheck = { used: int, checkedAt: int, found: bool, outstanding: Set[int] }
type CheckAdmission = { outcomeSaved: bool, referenceString: bool, portsPresent: bool, owned: bool,
  rowDecoded: bool, committed: bool, nowMs: int }
pure val initial: ReceiptCheck = { used: 0, checkedAt: 0, found: false, outstanding: Set() }
pure def canReserveReceiptCheck(s: ReceiptCheck, admission: CheckAdmission): bool =
  admission.outcomeSaved and admission.referenceString and admission.portsPresent and admission.owned and
    admission.rowDecoded and admission.committed and not(s.found) and s.used < 3 and
    admission.nowMs - s.checkedAt >= 60000
pure def reserveReceiptCheck(s: ReceiptCheck, admission: CheckAdmission): ReceiptCheck =
  { ...s, used: s.used + 1, checkedAt: admission.nowMs, outstanding: s.outstanding.union(Set(s.used + 1)) }
pure def canObserveReceiptCheck(s: ReceiptCheck, lookupId: int): bool = s.outstanding.contains(lookupId)
pure def observeReceiptCheck(s: ReceiptCheck, lookupId: int, exactMatch: bool, ownerCurrent: bool, confirmed: bool): ReceiptCheck =
  { ...s, found: s.found or (exactMatch and ownerCurrent and confirmed), outstanding: s.outstanding.exclude(Set(lookupId)) }
pure def canRetireReceiptReader(s: ReceiptCheck): bool = s.outstanding.size() > 0
pure def retireReceiptReader(s: ReceiptCheck): ReceiptCheck = { ...s, outstanding: Set() }
pure def alwaysReceiptBudgetBounded(s: ReceiptCheck): bool = s.used >= 0 and s.used <= 3
pure def alwaysFoundReceiptHasReservation(s: ReceiptCheck): bool =
  (s.found or s.outstanding.size() > 0) implies s.used > 0
pure def stepReceiptReservationSurvivesFailure(before: ReceiptCheck, via: str, after: ReceiptCheck): bool =
  via != "reserveReceiptCheck" implies after.used == before.used and after.checkedAt == before.checkedAt
pure def stepFoundReceiptStaysFound(before: ReceiptCheck, after: ReceiptCheck): bool =
  before.found implies after.found
pure def lawReceiptCooldownRefuses(s: ReceiptCheck, admission: CheckAdmission): bool =
  admission.nowMs - s.checkedAt < 60000 implies not(canReserveReceiptCheck(s,admission))
pure def sometimesReceiptSearchBudgetSpent(s: ReceiptCheck): bool = s.used == 3 and not(s.found)
pure def sometimesReceiptFound(s: ReceiptCheck): bool = s.found
pure val okayCheck: CheckAdmission = { outcomeSaved: true, referenceString: true, portsPresent: true, owned: true,
  rowDecoded: true, committed: true, nowMs: 60000 }
pure val admissionValues = Set(okayCheck, { ...okayCheck, nowMs: 120000 }, { ...okayCheck, nowMs: 180000 },
  { ...okayCheck, nowMs: 240000 }, { ...okayCheck, nowMs: 59999 }, { ...okayCheck, committed: false },
  { ...okayCheck, outcomeSaved: false }, { ...okayCheck, owned: false })
pure val lookupIdValues = Set(1,2,3,4)
pure val weight_reserveReceiptCheck = 8
pure val weight_observeReceiptCheck = 6
```

### The mailbox search needs one complete, current match to the provider reference

The finder accepts a case-sensitive provider reference of 3 through
128 characters. It starts with an ASCII letter or digit and the
remainder allows ASCII letters, digits, period, underscore, hyphen
or slash. Require a safe integer observation timestamp. Validate
and freeze the authorized task-and-account scope. The searched
window starts ten minutes before the observation and ends before
the current host time plus one minute. Authentication uses the
original scope. Before search, after search and after each detail
read, recheck the signal, grant and discovery generation.

Request one page of up to ten messages using the granted senders,
quoted reference and rounded-down earliest second. A continuation
token prevents claiming one match from a partial page. Ignore list
records outside the exact sender, recipient, time or ID scope.
Read candidate details in order. A returned detail must keep the
same ID and pass all scope checks, with a string body. A mismatch
or provider failure ends with a typed unavailable result. The
reference must appear in the body with a non-alphanumeric boundary
or the start or end of the string on both sides. Return true only
when exactly one qualifying result contains it. A false or
unavailable result leaves the saved payment outcome in place. The
model takes timestamps, address validation, body matching and
authorization checks as port observations, with no mailbox data.

```quint
type ReceiptSearch = { referenceValid: bool, timestampValid: bool, scopeValid: bool, currentGrant: bool,
  pageArray: bool, messageCount: int, continuation: bool, detailsValid: bool, exactMatches: int }
type ReceiptAnswer = NoReceiptMatch | ReceiptConfirmed | ReceiptUnavailable
pure def receiptSearchOutcome(searchFacts: ReceiptSearch): ReceiptAnswer =
  if (not(searchFacts.referenceValid and searchFacts.timestampValid)) NoReceiptMatch
  else if (not(searchFacts.scopeValid and searchFacts.currentGrant and searchFacts.pageArray) or
    searchFacts.messageCount < 0 or searchFacts.messageCount > 10) ReceiptUnavailable
  else if (searchFacts.continuation) NoReceiptMatch
  else if (not(searchFacts.detailsValid)) ReceiptUnavailable
  else if (searchFacts.exactMatches == 1 and searchFacts.messageCount >= 1) ReceiptConfirmed
  else NoReceiptMatch
pure def lawMultipleReceiptMatchesCannotConfirm(searchFacts: ReceiptSearch): bool =
  searchFacts.exactMatches > 1 implies receiptSearchOutcome(searchFacts) != ReceiptConfirmed
pure def lawIncompleteReceiptPageCannotConfirm(searchFacts: ReceiptSearch): bool =
  searchFacts.continuation implies receiptSearchOutcome(searchFacts) != ReceiptConfirmed
pure def lawRetiredMailboxCannotConfirmReceipt(searchFacts: ReceiptSearch): bool =
  not(searchFacts.currentGrant) implies receiptSearchOutcome(searchFacts) != ReceiptConfirmed
pure val receiptFound: ReceiptSearch = { referenceValid: true, timestampValid: true, scopeValid: true, currentGrant: true,
  pageArray: true, messageCount: 1, continuation: false, detailsValid: true, exactMatches: 1 }
pure val searchFactsValues = Set(receiptFound, { ...receiptFound, exactMatches: 0 },
  { ...receiptFound, messageCount: 2, exactMatches: 2 }, { ...receiptFound, continuation: true },
  { ...receiptFound, detailsValid: false }, { ...receiptFound, referenceValid: false },
  { ...receiptFound, currentGrant: false }, { ...receiptFound, messageCount: 11 })
```

The pinned `bill-submission.test.mjs` and
`bill-source-discovery.test.mjs` exercise SQLite reservation,
cooldown, restart, concurrent callers, one-mail confirmation and
scope/refusal checks. The composed configured browser path is in
Grace's `test-bill-configured-e2e-browser.mjs`.
