# Prioritization

Briefs the owner asks for are told from the [check-in brief](./checkin.md),
which reads the owner's calendar, to-dos, goals, routines and reminders.
This spec covers only ranking the owner's own items when they ask what
matters most.

## Story: Put my items in priority order when I ask

> As the owner, I can ask the agent to rank my to-dos, work threads,
> decisions or commitments, and the order it gives holds only my own items.

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
pure def lawRanksHoldOnlyTheOwnersItems(candidates: List[RankCandidate], ownerId: str, proposals: List[str]): bool =
  safeRanks(candidates, ownerId, proposals).every(id => rankableIdentity(candidates, ownerId, id))
pure val candidatesValues = Set(List(), List({ rankId: "todo-1", rankOwner: "owner" }, { rankId: "todo-2", rankOwner: "other" }))
pure val proposalsValues = Set(List(), List("todo-1", "todo-2", "todo-1", "unknown"))
```
