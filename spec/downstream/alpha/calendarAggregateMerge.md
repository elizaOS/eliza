# Canonical Calendar occurrence grouping and source projection

AlphaPhone uses the Eliza resident aggregate Calendar feed and its exact
source identity for selection. This contract follows
`mergeAggregatedCalendarFeedEvents` in
`plugins/plugin-calendar/src/service/CalendarService.ts` at
`c518127a025ab173874af9c7d304f26b25213b0d`. The
[managed feed](./managedCalendarFeed.md) owns source admission,
cache drain and mapped pull before merge. The
[canonical Calendar reader](./canonicalCalendarRead.md) owns the
renderer display and next-event freshness.

## Story: See one occurrence with its precise source evidence

### Exact link revisions or portable occurrence identity determine which copies can share a row

A portable identity uses the first nonblank trimmed metadata value in
`iCalUID`, `iCalUId`, `icalUid`, `icsUid`, in that order. It uses the
first nonblank `originalStartTime`, `icsRecurrenceId` or `originalStart`
for occurrence identity, falling back to current start. Timed occurrences
normalize to an instant. An all-day occurrence keeps a civil date. If its
identity is already a date token, the parser takes that token. If it
requires date projection, use the event time zone when supplied, otherwise
UTC. A failed time or time-zone conversion leaves portable identity absent.
A moved exception therefore groups by original occurrence, and timed
and all-day instances have different keys.

A link joins only the Eliza owner row with the exact agent, local ID and
revision to a Google owner row with the exact agent, connector account,
calendar, provider event ID and etag. An exact clean link must have no
pending operation. A dirty link qualifies only during pending update.
The link joins its local and provider rows under the remote portable
identity if available, otherwise under the link ID. A linked ID can
override a candidate's portable group. A candidate with neither uses
its provider, side, grant, connector account, calendar and event ID as
one structural source identity. Missing grant and connector account
use the containing source's values. Equal titles or times contribute
no linking evidence. URL-independent metadata decoding, canonical
time conversion and exact comparison facts come from the value ports.

```quint
type PortableCalendarOccurrence = { uid: str, occurrenceKey: str, allDay: bool, conversionSucceeded: bool }
type CompleteCalendarLink = { cleanLink: bool, pending: bool, dirtyUpdate: bool,
  localAgentAndRevision: bool, exactProviderSnapshot: bool, linkKey: str }
type CalendarGroupKind = MappedGroup | PortableGroup | OriginalSourceGroup
type CalendarGroup = { groupKind: CalendarGroupKind, firstIdentity: str, secondIdentity: str, allDay: bool }
pure def portableCalendarIdentity(candidate: PortableCalendarOccurrence): bool =
  candidate.uid != "" and candidate.occurrenceKey != "" and candidate.conversionSucceeded
pure def canonicalMappingPairs(link: CompleteCalendarLink): bool =
  ((link.cleanLink and not(link.pending)) or link.dirtyUpdate) and
    link.localAgentAndRevision and link.exactProviderSnapshot
pure def calendarMergeGroup(link: CompleteCalendarLink, remote: PortableCalendarOccurrence,
  candidate: PortableCalendarOccurrence, exactSourceKey: str): CalendarGroup =
  if (canonicalMappingPairs(link))
    (if (portableCalendarIdentity(remote))
      { groupKind: PortableGroup, firstIdentity: remote.uid, secondIdentity: remote.occurrenceKey, allDay: remote.allDay }
     else { groupKind: MappedGroup, firstIdentity: link.linkKey, secondIdentity: "", allDay: false })
  else if (portableCalendarIdentity(candidate))
    { groupKind: PortableGroup, firstIdentity: candidate.uid, secondIdentity: candidate.occurrenceKey, allDay: candidate.allDay }
  else { groupKind: OriginalSourceGroup, firstIdentity: exactSourceKey, secondIdentity: "", allDay: false }
pure def lawLinkNeedsBothRevisions(link: CompleteCalendarLink): bool =
  canonicalMappingPairs(link) implies link.localAgentAndRevision and link.exactProviderSnapshot
pure def lawWithoutPortableOrLinkKeepSource(link: CompleteCalendarLink, remote: PortableCalendarOccurrence,
  candidate: PortableCalendarOccurrence, exactSourceKey: str): bool =
  val grouping = calendarMergeGroup(link,remote,candidate,exactSourceKey)
  not(canonicalMappingPairs(link) or portableCalendarIdentity(candidate)) implies
    grouping.groupKind == OriginalSourceGroup and grouping.firstIdentity == exactSourceKey and
    grouping.secondIdentity == "" and not(grouping.allDay)
pure def lawMappedPortablePreservesTimeKind(link: CompleteCalendarLink, remote: PortableCalendarOccurrence,
  candidate: PortableCalendarOccurrence, exactSourceKey: str): bool =
  (canonicalMappingPairs(link) and portableCalendarIdentity(remote)) implies
    calendarMergeGroup(link,remote,candidate,exactSourceKey).allDay == remote.allDay
pure val currentMapping: CompleteCalendarLink = { cleanLink: true, pending: false, dirtyUpdate: false,
  localAgentAndRevision: true, exactProviderSnapshot: true, linkKey: "mapped" }
pure val linkValues = Set(currentMapping, { ...currentMapping, exactProviderSnapshot: false },
  { ...currentMapping, pending: true }, { ...currentMapping, cleanLink: false, pending: true, dirtyUpdate: true })
pure val portableInstance: PortableCalendarOccurrence = { uid: "uid", occurrenceKey: "original", allDay: false, conversionSucceeded: true }
pure val candidateValues = Set(portableInstance, { ...portableInstance, allDay: true },
  { ...portableInstance, uid: "" }, { ...portableInstance, conversionSucceeded: false })
pure val remoteValues = candidateValues
pure val exactSourceKeyValues = Set("owner:grant1:event1","owner:grant2:event1")
```

### Current mapped local row or ordered provider metadata selects the visible copy

A group with a current linked local row uses its first such row in source
order. Otherwise compare updated time, source sequence, owner side,
access role, provider rank, and sync time in that order, higher first.
Missing or nonfinite numbers contribute zero. Sequence comes from the
first finite numeric or numeric-string `icsSequence` or `sequence`.
Access ranks range from owner, writer, reader, free-busy reader, other,
to none. Provider rank is Eliza, Google and Microsoft together, Apple,
then ICS. A remaining tie uses the ascending locale order of event IDs,
with an exact tie retaining the earlier candidate. The shell provides
parsed numbers and locale order as comparator observations. The model
uses integer comparison classes and retains earlier candidates on ties.

Each selected event carries its actual source properties. Existing event
values take precedence, using the source grant, account, address or
summary where event values are absent. A singleton keeps the event
without a new deduplication record. A group with multiple source rows
records every source reference and the fields whose string values differ:
title, status, start, end, location and description. A linked local winner
with a pending update preserves all original event snapshots under the
link ID. The final list sorts by event start and then event ID.
Linked lookups and grouping use the pinned event ID namespace. Distinct
source identities cannot establish linkage just because their display
fields match.

```quint
type CalendarRank = { touched: int, sequenceRank: int, ownerSide: bool, accessRank: int, providerRank: int, synced: int }
type RankedCalendarRow = { linkedLocal: bool, rank: CalendarRank }
type CalendarMergeOutput = { recordSources: bool, recordConflicts: bool, preserveSnapshots: bool }
pure def calendarRankGreater(leftRank: CalendarRank, rightRank: CalendarRank): bool =
  if (leftRank.touched != rightRank.touched) leftRank.touched > rightRank.touched
  else if (leftRank.sequenceRank != rightRank.sequenceRank) leftRank.sequenceRank > rightRank.sequenceRank
  else if (leftRank.ownerSide != rightRank.ownerSide) leftRank.ownerSide
  else if (leftRank.accessRank != rightRank.accessRank) leftRank.accessRank > rightRank.accessRank
  else if (leftRank.providerRank != rightRank.providerRank) leftRank.providerRank > rightRank.providerRank
  else leftRank.synced > rightRank.synced
pure def sameCalendarRank(leftRank: CalendarRank, rightRank: CalendarRank): bool =
  leftRank.touched == rightRank.touched and leftRank.sequenceRank == rightRank.sequenceRank and
  leftRank.ownerSide == rightRank.ownerSide and leftRank.accessRank == rightRank.accessRank and
  leftRank.providerRank == rightRank.providerRank and leftRank.synced == rightRank.synced
pure def calendarChallengerWins(winner: RankedCalendarRow, challenger: RankedCalendarRow, idOrdersFirst: bool): bool =
  not(winner.linkedLocal) and
    (challenger.linkedLocal or calendarRankGreater(challenger.rank,winner.rank) or
      (sameCalendarRank(challenger.rank,winner.rank) and idOrdersFirst))
pure def calendarMergeOutput(sourceRows: int, linkedLocalWinner: bool, pendingUpdate: bool): CalendarMergeOutput =
  { recordSources: sourceRows > 1, recordConflicts: sourceRows > 1,
    preserveSnapshots: sourceRows > 1 and linkedLocalWinner and pendingUpdate }
pure def lawFirstMappedWinnerStays(winner: RankedCalendarRow, challenger: RankedCalendarRow, idOrdersFirst: bool): bool =
  winner.linkedLocal implies not(calendarChallengerWins(winner,challenger,idOrdersFirst))
pure def lawCalendarTieKeepsSourceOrder(winner: RankedCalendarRow, challenger: RankedCalendarRow): bool =
  (sameCalendarRank(winner.rank,challenger.rank) and not(challenger.linkedLocal)) implies
    not(calendarChallengerWins(winner,challenger,false))
pure def lawCalendarPendingSnapshotRequiresMultipleCopies(sourceRows: int, linkedLocalWinner: bool, pendingUpdate: bool): bool =
  calendarMergeOutput(sourceRows,linkedLocalWinner,pendingUpdate).preserveSnapshots implies
    sourceRows > 1 and linkedLocalWinner and pendingUpdate
pure val baseRank: CalendarRank = { touched: 1, sequenceRank: 1, ownerSide: true, accessRank: 5, providerRank: 4, synced: 1 }
pure val leftRankValues = Set(baseRank,{ ...baseRank, touched: 2 },{ ...baseRank, ownerSide: false })
pure val rightRankValues = leftRankValues
pure val winnerValues = Set({ linkedLocal: false, rank: baseRank }, { linkedLocal: true, rank: baseRank },
  { linkedLocal: false, rank: { ...baseRank, touched: 2 } }, { linkedLocal: false, rank: { ...baseRank, ownerSide: false } })
pure val challengerValues = winnerValues
pure val sourceRowsValues = Set(0,1,2,3)
```
