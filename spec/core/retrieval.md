# Ranked retrieval

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/retrieval.ts`, `packages/core/src/capabilities/retrieval.ts` and `packages/core/src/types/search.ts`, with the BM25 vectors in [the numeric fixtures](./baseline/numeric-fixtures.json). The corpus, its term frequencies and the BM25 formula are [retrieval corpus](./retrievalIndex.md). This library says how scored candidates become a result page: which candidates may appear, in what order and how many. Scores are the boundary's: lexical rank first, then trigram or vector similarity, then recency, as the source sorts them.

## Story: Ranked retrieval

> As a user, I want a search over the agent's memory to return the best
> matches I am allowed to read, in the same order every time, and nothing
> when I ask for none, so that results are reproducible and never leak
> another conversation's memory.

### Ranking is a total order, so the same candidates always rank the same

A candidate ranks before another by higher score, then higher similarity, then newer creation time, then lower identity. Identities are distinct, so no two candidates tie and the order the store returned them in cannot change the result.

```quint
type Candidate = { id: int, score: int, similarity: int, createdAt: int, scope: str }
type OrderCheck = { previous: Candidate, started: bool, valid: bool }
pure def ranksBefore(a: Candidate, b: Candidate): bool =
  a.score > b.score or (a.score == b.score and (a.similarity > b.similarity or (a.similarity == b.similarity and (a.createdAt > b.createdAt or (a.createdAt == b.createdAt and a.id < b.id)))))
pure def insertRanked(ranked: List[Candidate], c: Candidate): List[Candidate] =
  ranked.select(other => ranksBefore(other, c)).append(c).concat(ranked.select(other => not(ranksBefore(other, c))))
pure def rank(candidates: List[Candidate]): List[Candidate] = candidates.foldl(List(), (ranked, c) => insertRanked(ranked, c))
pure def reversed(candidates: List[Candidate]): List[Candidate] = candidates.foldl(List(), (acc, c) => List(c).concat(acc))
pure def distinctIds(candidates: List[Candidate]): bool = candidates.every(c => candidates.select(other => other.id == c.id).length() == 1)
pure val noCandidate: Candidate = { id: 0, score: 0, similarity: 0, createdAt: 0, scope: "" }
pure def ordered(ranked: List[Candidate]): bool =
  ranked.foldl({ previous: noCandidate, started: false, valid: true }, (check, c) => { previous: c, started: true, valid: check.valid and (not(check.started) or ranksBefore(check.previous, c)) }).valid
pure val candidatesValues = Set(
  List(),
  List({ id: 1, score: 2, similarity: 0, createdAt: 1, scope: "room-a" }, { id: 2, score: 2, similarity: 1, createdAt: 0, scope: "room-a" }),
  List({ id: 3, score: 1, similarity: 0, createdAt: 2, scope: "room-b" }, { id: 1, score: 2, similarity: 0, createdAt: 1, scope: "room-a" }, { id: 4, score: 1, similarity: 0, createdAt: 2, scope: "room-a" }),
  List({ id: 5, score: 0, similarity: 0, createdAt: 0, scope: "room-b" }, { id: 6, score: 3, similarity: 0, createdAt: 0, scope: "room-b" }, { id: 2, score: 2, similarity: 1, createdAt: 0, scope: "room-a" })
)
pure def lawRankIsOrdered(candidates: List[Candidate]): bool = distinctIds(candidates) implies ordered(rank(candidates))
pure val shuffledValues = Set(
  List({ id: 2, score: 2, similarity: 1, createdAt: 0, scope: "room-a" }, { id: 1, score: 2, similarity: 0, createdAt: 1, scope: "room-a" }),
  List({ id: 1, score: 2, similarity: 0, createdAt: 1, scope: "room-a" }, { id: 4, score: 1, similarity: 0, createdAt: 2, scope: "room-a" }, { id: 3, score: 1, similarity: 0, createdAt: 2, scope: "room-b" }),
  List({ id: 4, score: 1, similarity: 0, createdAt: 2, scope: "room-a" }, { id: 3, score: 1, similarity: 0, createdAt: 2, scope: "room-b" }, { id: 1, score: 2, similarity: 0, createdAt: 1, scope: "room-a" }),
  List({ id: 2, score: 2, similarity: 1, createdAt: 0, scope: "room-a" }, { id: 5, score: 0, similarity: 0, createdAt: 0, scope: "room-b" }, { id: 6, score: 3, similarity: 0, createdAt: 0, scope: "room-b" })
)
pure def sameMembers(a: List[Candidate], b: List[Candidate]): bool = a.length() == b.length() and a.every(c => b.includes(c)) and b.every(c => a.includes(c))
pure def lawRankIgnoresStoreOrder(candidates: List[Candidate]): bool = distinctIds(candidates) implies rank(candidates) == rank(reversed(candidates))
pure def lawRankIgnoresAnyStoreOrder(candidates: List[Candidate], shuffled: List[Candidate]): bool =
  (distinctIds(candidates) and sameMembers(candidates, shuffled)) implies rank(candidates) == rank(shuffled)
```

### A non-positive limit returns nothing

A page is the first `limit` candidates of the ranking. A limit of zero or less is not a request for everything: it returns an empty page.

```quint
pure def firstOf(ranked: List[Candidate], limit: int): List[Candidate] = ranked.foldl(List(), (page, c) => if (page.length() < limit) page.append(c) else page)
pure def retrieve(candidates: List[Candidate], scopes: List[str], limit: int): List[Candidate] =
  if (limit <= 0) List() else firstOf(rank(candidates.select(c => scopes.includes(c.scope))), limit)
pure val scopesValues = Set(List(), List("room-a"), List("room-a", "room-b"))
pure def lawNonPositiveLimitReturnsNothing(candidates: List[Candidate], scopes: List[str], limit: int): bool =
  limit <= 0 implies retrieve(candidates, scopes, limit) == List()
pure def lawPageHoldsAtMostTheLimit(candidates: List[Candidate], scopes: List[str], limit: int): bool =
  retrieve(candidates, scopes, limit).length() <= (if (limit < 0) 0 else limit)
```

### Nothing outside the caller's memory scope is returned

The caller's scopes are the rooms and worlds whose memory it may read, decided before retrieval. A candidate from any other scope is removed before ranking, so it neither appears nor displaces a readable one.

```quint
pure def lawResultsStayInScope(candidates: List[Candidate], scopes: List[str], limit: int): bool =
  retrieve(candidates, scopes, limit).every(c => scopes.includes(c.scope))
```
