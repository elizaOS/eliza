# Ranked retrieval

Ranked retrieval over the agent's memory, from `retrieval.ts`, `capabilities/retrieval.ts` and `types/search.ts`: the corpus that feeds lexical scoring, and how scored candidates become a result page. Scores are boundary inputs, lexical rank first, then trigram or vector similarity, then recency; the [numeric fixtures](./baseline/numeric-fixtures.json) are the conformance oracle for the BM25 arithmetic.

## Story: Maintain the corpus

> As a retrieval consumer, I want document counts, term presence and
> document-frequency inputs to describe the same corpus after append and
> clear, so that lexical scores never use stale frequencies.

The optional in-memory BM25 corpus keeps documents in insertion order with their source object identity. Empty and nonstring fields add no tokens. `clearDocuments` resets every document, term, frequency and average.

### Appending records adds one document and registers each distinct term once

The token adapter applies configured cleanup, stop words, numeric token exemptions, minimum length, custom stemming rules and optional Porter2 stemming. This model consumes that exact token sequence and the source Uint32-coerced stored length. Weighted term-frequency arithmetic remains the numerical contract below. Bulk append repeats the same append operation in order.

```quint
type CorpusDocument = { payload: str, tokens: List[str], storedLength: int }
type Corpus = { documents: List[CorpusDocument], terms: List[str] }
pure val emptyDocument: CorpusDocument = { payload: "", tokens: List(), storedLength: 0 }
pure val initial: Corpus = { documents: List(), terms: List() }
pure def canAddDocument(c: Corpus, storedLength: int): bool = storedLength >= 0 and storedLength <= 4294967295
pure def addDocument(c: Corpus, payload: str, tokens: List[str], storedLength: int): Corpus = { documents: c.documents.append({ payload: payload, tokens: tokens, storedLength: storedLength }), terms: tokens.foldl(c.terms, (known, term) => if (known.includes(term)) known else known.append(term)) }
pure def clearDocuments(c: Corpus): Corpus = initial
pure def documentFrequency(c: Corpus, term: str): int = c.documents.foldl(0, (count, document) => count + (if (document.tokens.includes(term)) 1 else 0))
pure def rawTermFrequency(c: Corpus, documentIndex: int, term: str): int = c.documents.nthOr(documentIndex, emptyDocument).tokens.foldl(0, (count, token) => count + (if (token == term) 1 else 0))
pure def averageLengthNumerator(c: Corpus): int = c.documents.foldl(0, (total, document) => total + document.storedLength)
pure def averageLengthDenominator(c: Corpus): int = c.documents.length()
pure def alwaysStoredLengthsUnsigned(c: Corpus): bool = c.documents.every(document => document.storedLength >= 0 and document.storedLength <= 4294967295)
pure def sometimesCorpusPopulated(c: Corpus): bool = c.documents.length() > 0
pure def sometimesCorpusHasTerms(c: Corpus): bool = c.terms.length() > 0
```

### IDF inputs and score ordering retain the source numerical formulas

For document count N and document frequency n, IDF is `log(1 + (N - n + 0.5)/(n + 0.5))`. Unknown indices, zero frequency and frequency above N return zero. A term contributes `idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / averageLength))`. Default k1 is 1.2 and b is 0.75. Field boost uses JavaScript `configuredBoost || 1`, so zero falls back to one. Document lengths and frequencies use Uint32 storage. Search scores accumulate in Float32, retain only scores above zero and sort descending, preserving earlier document indices on ties. Phrase search first intersects term-document presence and then checks adjacent token sequences. Message search preserves the source's websearch, trigram, recency and id ordering separately.

This integer model claims no real-number arithmetic: IEEE arithmetic, logarithms, typed-array coercion, Porter2 and Unicode transformation and lexical parsing are checked against the [numeric fixtures](./baseline/numeric-fixtures.json), including the constructor's raw weighted average and incremental append's average over stored Uint32 lengths. Scores enter ranking below as boundary inputs.

```quint
pure def idfHasEvidence(documentCount: int, frequency: int, indexExists: bool): bool = indexExists and frequency > 0 and frequency <= documentCount
pure def lawInvalidFrequencyHasNoIdf(documentCount: int, frequency: int): bool = (frequency <= 0 or frequency > documentCount) implies not(idfHasEvidence(documentCount, frequency, true))
```

## Story: Ranked retrieval

> As a user, I want a search over the agent's memory to return the best
> matches I am allowed to read, in the same order every time, and nothing
> when I ask for none, so that results are reproducible and never leak
> memory outside my authorized scopes.

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

### Capability retrieval rejects a limit that is not a positive integer

An omitted capability retrieval limit is 5, and a positive integer limit is kept as the page bound. Unlike memory retrieval, a given limit of zero or less, or one that is not an integer, does not give an empty page: retrieval fails with the error code `INVALID_CAPABILITY_RETRIEVAL_INPUT`.

```quint
type CapabilityLimitCheck = { accepted: bool, errorCode: str, pageLimit: int }
pure val defaultCapabilityRetrievalLimit: int = 5
pure val invalidCapabilityRetrievalInput: str = "INVALID_CAPABILITY_RETRIEVAL_INPUT"
pure def checkCapabilityLimit(given: bool, limit: int, integral: bool): CapabilityLimitCheck =
  if (not(given)) { accepted: true, errorCode: "", pageLimit: defaultCapabilityRetrievalLimit }
  else if (integral and limit > 0) { accepted: true, errorCode: "", pageLimit: limit }
  else { accepted: false, errorCode: invalidCapabilityRetrievalInput, pageLimit: 0 }
pure def lawCapabilityLimitNotPositiveIntegerIsRejected(limit: int, integral: bool): bool =
  (limit <= 0 or not(integral)) implies (checkCapabilityLimit(true, limit, integral) == { accepted: false, errorCode: invalidCapabilityRetrievalInput, pageLimit: 0 })
pure def lawCapabilityLimitPositiveIntegerIsKept(limit: int): bool =
  limit > 0 implies checkCapabilityLimit(true, limit, true) == { accepted: true, errorCode: "", pageLimit: limit }
pure def lawOmittedCapabilityLimitIsFive(limit: int, integral: bool): bool =
  checkCapabilityLimit(false, limit, integral) == { accepted: true, errorCode: "", pageLimit: 5 }
```

### Nothing outside the caller's memory scope is returned

The caller's scopes are the rooms and worlds whose memory it may read, decided before retrieval. A candidate from any other scope is removed before ranking, so it neither appears nor displaces a readable one.

```quint
pure def lawResultsStayInScope(candidates: List[Candidate], scopes: List[str], limit: int): bool =
  retrieve(candidates, scopes, limit).every(c => scopes.includes(c.scope))
```
