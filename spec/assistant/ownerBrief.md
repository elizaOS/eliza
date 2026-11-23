# Owner briefs and prioritization

## Story: See a private brief assembled from my connected data

> As the owner, I can request a fresh brief for a selected interval. The brief includes calendar, inbox, commitments, and other items only when I can read the source.

### Each included entry belongs to the requested owner and lies within the brief's interval

The shell obtains source projections from the account's existing connected packages and binds each projection to the current owner read grant. Model output may choose or explain an admitted entry by ID. Model output cannot introduce an entry absent from the read set.

```quint
type BriefSource = CalendarEntry | InboxEntry | LifeEntry | MoneyEntry | CommitmentEntry
type BriefItem = { itemOwner: str, briefId: str, source: BriefSource, itemAt: int, sourceReadable: bool }
type BriefRequest = { briefOwner: str, startsAt: int, endsAt: int, includedSources: Set[BriefSource] }
pure def briefIncludes(entry: BriefItem, request: BriefRequest): bool =
  entry.itemOwner == request.briefOwner and request.briefOwner != "" and entry.briefId != "" and
  entry.itemAt >= request.startsAt and entry.itemAt < request.endsAt and
  entry.sourceReadable and request.includedSources.contains(entry.source)
pure def eligibleBriefItems(items: List[BriefItem], request: BriefRequest): List[BriefItem] =
  items.select(entry => briefIncludes(entry, request))
pure def lawBriefItemsAreScoped(items: List[BriefItem], request: BriefRequest): bool =
  eligibleBriefItems(items, request).every(entry => entry.itemOwner == request.briefOwner and entry.sourceReadable)
```

### A suggestion can rank only identities present in the current source set

The model receives owner-scoped to-dos, work threads, decisions, or commitments. Its suggested rank is an external observation. The shell rejects ambiguous or unknown IDs and projects a bounded ordered sequence of original items.

```quint
type RankCandidate = { rankId: str, rankOwner: str }
pure def rankableIdentity(candidates: List[RankCandidate], ownerId: str, proposedId: str): bool =
  ownerId != "" and proposedId != "" and candidates.select(row => row.rankOwner == ownerId and row.rankId == proposedId).length() == 1
pure def safeRanks(candidates: List[RankCandidate], ownerId: str, proposals: List[str]): List[str] =
  proposals.foldl(List(), (seen, proposedId) =>
    if (rankableIdentity(candidates, ownerId, proposedId) and not(seen.includes(proposedId))) seen.append(proposedId) else seen)
pure def lawNoUnknownIdentityFitsEmptyRank(ownerId: str, proposals: List[str]): bool =
  safeRanks(List(), ownerId, proposals).length() == 0
pure val itemsValues = Set(List(), List({ itemOwner: "owner", briefId: "event-1", source: CalendarEntry, itemAt: 50, sourceReadable: true }, { itemOwner: "other", briefId: "mail-1", source: InboxEntry, itemAt: 50, sourceReadable: false }))
pure val requestValues = Set({ briefOwner: "owner", startsAt: 0, endsAt: 60, includedSources: Set(CalendarEntry, InboxEntry) }, { briefOwner: "owner", startsAt: 60, endsAt: 90, includedSources: Set(CalendarEntry) })
```
