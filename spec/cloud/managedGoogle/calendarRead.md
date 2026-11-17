# Managed calendar reads

The managed Google host reads an owner's calendars through the cloud: it
discovers the calendar sources each connected account may read and serves a
chosen calendar's feed. It shares in-flight and very recent lookups only
within one owner's credential, keeps the exact grant and calendar identity
from discovery through the feed, and publishes nothing without a fresh
check that the grant still holds. The full cloud credential, request and
response stay at the ports. Transport decoding, the downstream cache and the
mapping pull are [the managed calendar feed](../../calendar/managedFeed.md);
keeping a synced copy current is [calendar sync](./calendarSync.md).

## Story: Read a chosen Calendar source while its Google grant remains current

> As an owner, I want my agent to read only the calendar I chose, through the
> Google account that holds it, and to stop the moment that account's grant
> is gone.

### A lookup may be shared only while its owner scope and cache entry agree

The host hashes the exact serialized credential it captured at the
beginning of a read; a different owner key clears the lookup table.
The owner-account key is that credential digest. A calendar-list key
also binds the actual connected Google grant ID. Owner and calendar
lookups do not share responses across keys or with another credential.

A lookup is young while both its wall and monotonic ages are under five
seconds. Source discovery and feed reads can join a young in-flight
lookup, and a feed can also reuse a young completed one; a source list
otherwise starts its own read. A joining caller whose shared read rejects
reads on its own without installing an entry. Success marks the exact entry
completed and evicts it after five seconds; rejection or that timer removes
the entry only if the slot still holds that exact read, so a previous
owner's read never evicts its successor.

```quint
type LookupPhase = LookupEmpty | LookupPending | LookupCompleted
type ReadKind = SourceDiscovery | CalendarFeed
type LookupPlan = StartLookup | JoinLookup | ReuseLookup
type LookupSlot = { authority: int, slotKey: int, nextTicket: int, lookupTicket: int, lookupPhase: LookupPhase }
pure val initial: LookupSlot = { authority: 1, slotKey: 0, nextTicket: 0, lookupTicket: 0, lookupPhase: LookupEmpty }
pure def youngLookup(wallAge: int, monotonicAge: int): bool = wallAge < 5000 and monotonicAge < 5000
pure def lookupPlan(s: LookupSlot, readKind: ReadKind, queryKey: int, wallAge: int, monotonicAge: int): LookupPlan =
  if (s.slotKey != queryKey or not(youngLookup(wallAge, monotonicAge))) StartLookup
  else if (s.lookupPhase == LookupPending) JoinLookup
  else if (s.lookupPhase == LookupCompleted and readKind == CalendarFeed) ReuseLookup else StartLookup
pure def emptyLookup(kprior: int, s: LookupSlot): LookupSlot =
  { ...s, authority: kprior, slotKey: 0, lookupTicket: 0, lookupPhase: LookupEmpty }
pure def changeLookupAuthority(s: LookupSlot): LookupSlot = emptyLookup(s.authority + 1, s)
pure def canInstallLookup(s: LookupSlot, queryKey: int): bool = queryKey > 0
pure def installLookup(s: LookupSlot, queryKey: int): LookupSlot =
  { ...s, slotKey: queryKey, nextTicket: s.nextTicket + 1, lookupTicket: s.nextTicket + 1, lookupPhase: LookupPending }
type LookupObservation = LookupSucceeded | LookupRejected | LookupAged
pure def canObserveLookup(s: LookupSlot): bool = s.lookupPhase != LookupEmpty
pure def observeLookup(s: LookupSlot, exactTicket: bool, lookupObservation: LookupObservation): LookupSlot =
  if (not(exactTicket)) s
  else if (lookupObservation == LookupRejected or lookupObservation == LookupAged) emptyLookup(s.authority, s)
  else { ...s, lookupPhase: LookupCompleted }
pure def canInvalidateLookups(s: LookupSlot): bool = s.lookupPhase != LookupEmpty
pure def invalidateLookups(s: LookupSlot): LookupSlot = emptyLookup(s.authority, s)
pure def alwaysLookupTicketIdentifiesEntry(s: LookupSlot): bool =
  s.nextTicket >= 0 and (if (s.lookupPhase == LookupEmpty) s.lookupTicket == 0 and s.slotKey == 0
    else s.lookupTicket > 0 and s.lookupTicket == s.nextTicket and s.slotKey > 0)
pure def stepAuthorityChangeClearsLookup(before: LookupSlot, via: str, after: LookupSlot): bool =
  via == "changeLookupAuthority" implies after.lookupPhase == LookupEmpty and after.authority == before.authority + 1
pure def lawExpiredLookupStartsNew(s: LookupSlot, readKind: ReadKind, queryKey: int, wallAge: int, monotonicAge: int): bool =
  (wallAge >= 5000 or monotonicAge >= 5000) implies lookupPlan(s, readKind, queryKey, wallAge, monotonicAge) == StartLookup
pure def lawDiscoveryNeverReusesCompleted(s: LookupSlot, queryKey: int, wallAge: int, monotonicAge: int): bool =
  s.lookupPhase == LookupCompleted implies lookupPlan(s, SourceDiscovery, queryKey, wallAge, monotonicAge) == StartLookup
pure def sometimesLookupCompletes(s: LookupSlot): bool = s.lookupPhase == LookupCompleted
pure val queryKeyValues = Set(0, 1, 2)
pure val wallAgeValues = Set(-1, 0, 4999, 5000, 5001)
pure val monotonicAgeValues = Set(0, 4999, 5000, 5001)
```

### Discovery keeps exact grant and calendar identity through the feed

The native Cloud port accepts an admitted production credential
reference only. It checks its current authority and cancellation before
the fixed read and again after parsing. The host gives each read a
30-second deadline combined with caller cancellation. It verifies the
Cloud user and organization before listing accounts and checks the
same serialized credential again. A source discovery with no optional
credential returns an empty contribution. Connected owner, provider
and verification failures remain refusals.

Only connected accounts with an exact connection ID and
`google.calendar.read` enter discovery. Per account the host projects
reader, writer and owner calendars. The visible account label is
descriptive. It never selects a grant. An opaque grant hashes the
credential identity and provider grant ID; both the feed grant and
connector identity use that scope. The real managed connection ID
stays available in source metadata. A feed requires the exact opaque
scope and calendar ID under a readable role. If a young reused
calendar list lacks that calendar, a second lookup excludes completed
cache entries. It may still join a young in-flight read. Continued
absence or an unowned scope refuses the request. The reducer receives
classification of exact scope and calendar lookups from the port.

```quint
type CalendarSelection = FeedUsesSelectedCalendar | RefreshCalendarList | FeedSelectionRefused
pure def selectCalendar(scopeExact: bool, readableCalendar: bool, freshLookupTried: bool): CalendarSelection =
  if (not(scopeExact)) FeedSelectionRefused
  else if (readableCalendar) FeedUsesSelectedCalendar
  else if (freshLookupTried) FeedSelectionRefused else RefreshCalendarList
pure def lawMissingCalendarRefreshesOnce(scopeExact: bool): bool =
  selectCalendar(scopeExact, false, true) == FeedSelectionRefused
```

### The fresh trailing grant check owns publication

Before publishing any discovery result, the host freshly lists accounts
and confirms that every selected connection still holds the capability.
Before publishing a feed it does the same for that one connection.
A cached lookup gives no trailing authority. The trailing check also
checks the original credential and cancellation. Failure in the
trailing calendar confirmation clears the shared lookup table. A feed
body failure after owner admission also clears it. These invalidations
are whole-table clears, even if another read installed a newer entry
while this request was running. Earlier owner discovery failure before
feed admission does not pass through the feed-body catch. Candidate
feed output over 256 KiB is refused whole after rechecking the grant.
The same result is used with timing diagnostics on or off.

```quint
type CalendarReadFacts = { credentialPresent: bool, initialAuthority: bool, exactScope: bool,
  providerReturned: bool, freshGrants: bool, credentialCurrent: bool, cancelled: bool, outputBytes: int }
type CalendarPublication = OptionalSourcesEmpty | ReadRefused | ResultTooLarge | ResultCurrent
pure val currentCalendarFacts: CalendarReadFacts = { credentialPresent: true, initialAuthority: true, exactScope: true,
  providerReturned: true, freshGrants: true, credentialCurrent: true, cancelled: false, outputBytes: 262144 }
pure val calendarFactsValues = Set(currentCalendarFacts, { ...currentCalendarFacts, credentialPresent: false },
  { ...currentCalendarFacts, initialAuthority: false }, { ...currentCalendarFacts, exactScope: false },
  { ...currentCalendarFacts, providerReturned: false }, { ...currentCalendarFacts, freshGrants: false },
  { ...currentCalendarFacts, credentialCurrent: false }, { ...currentCalendarFacts, cancelled: true },
  { ...currentCalendarFacts, outputBytes: 262145 })
pure def calendarPublication(readKind: ReadKind, calendarFacts: CalendarReadFacts): CalendarPublication =
  if (readKind == SourceDiscovery and not(calendarFacts.credentialPresent)) OptionalSourcesEmpty
  else if (not(calendarFacts.credentialPresent and calendarFacts.initialAuthority and calendarFacts.exactScope and
    calendarFacts.providerReturned and calendarFacts.freshGrants and calendarFacts.credentialCurrent) or calendarFacts.cancelled) ReadRefused
  else if (readKind == CalendarFeed and calendarFacts.outputBytes > 262144) ResultTooLarge else ResultCurrent
pure def lawPublicationRequiresFreshAuthority(readKind: ReadKind, calendarFacts: CalendarReadFacts): bool =
  calendarPublication(readKind, calendarFacts) == ResultCurrent implies
    calendarFacts.freshGrants and calendarFacts.credentialCurrent and not(calendarFacts.cancelled)
pure def lawOversizeFeedIsNeverPublished(calendarFacts: CalendarReadFacts): bool =
  calendarFacts.outputBytes > 262144 implies calendarPublication(CalendarFeed, calendarFacts) != ResultCurrent
```
