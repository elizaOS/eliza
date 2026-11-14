# Retrieval corpus state

Source `retrieval.ts` owns the optional in-memory BM25 corpus and tokenizer configuration. Documents retain insertion order and source object identity. Empty and nonstring fields add no tokens. `clearDocuments` resets every document, term, frequency and average structure. Porter2 code retains its upstream MIT attribution.

## Story: Update a searchable corpus without stale frequencies

As a retrieval consumer, I want document counts, term presence and document-frequency inputs to describe the same corpus after append and clear.

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

The exact IEEE arithmetic, logarithm, typed-array coercion, Porter2/Unicode transformation and lexical parsing are future pure implementation proof boundaries. No real-number approximation is claimed by this integer corpus model. The [captured numeric fixtures](./baseline/numeric-fixtures.json), baseline function contracts and fixtures retain these operations and their numeric inputs, including the constructor's raw weighted average and incremental append's average over stored Uint32 lengths.

```quint
pure def idfHasEvidence(documentCount: int, frequency: int, indexExists: bool): bool = indexExists and frequency > 0 and frequency <= documentCount
pure def lawUnknownTermHasNoIdf(documentCount: int, frequency: int): bool = not(idfHasEvidence(documentCount, frequency, false))
pure def lawInvalidFrequencyHasNoIdf(documentCount: int, frequency: int): bool = (frequency <= 0 or frequency > documentCount) implies not(idfHasEvidence(documentCount, frequency, true))
```
