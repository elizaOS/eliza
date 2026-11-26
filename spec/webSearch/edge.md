# Edge search and public fetch policy

This specification covers edge provider selection, anonymous public article
fetches, typed provider outage classification, and bounded compact result
projections.

## Story: Bound edge provider selection and public article fetches

> As the runtime, I want fallback search providers to require explicit host
> opt-in, public article fetches to reject private, duplicate, aborted, or
> oversized batches before network I/O, and provider outages to stay distinct
> from successful zero-hit searches.

### Fallback search requires explicit host opt-in

The default edge search action runs only the default free provider. Choosing
`fallback` is admitted only when the host explicitly opts in with a custom
runner, and any unknown provider is rejected before network I/O.

```quint
type EdgeProviderChoice = DefaultChoice | FallbackChoice | UnknownChoice
type EdgeProviderVerdict = AdmitDefault | AdmitFallback | RefuseFallbackUnavailable | RefuseUnsupportedProvider
pure def admitEdgeProvider(choice: EdgeProviderChoice, fallbackEnabled: bool): EdgeProviderVerdict =
  match choice {
    | DefaultChoice => AdmitDefault
    | FallbackChoice => if (fallbackEnabled) AdmitFallback else RefuseFallbackUnavailable
    | UnknownChoice => RefuseUnsupportedProvider
  }
pure def lawFallbackDeniedByDefault(choice: EdgeProviderChoice): bool =
  choice == FallbackChoice implies admitEdgeProvider(choice, false) == RefuseFallbackUnavailable
pure def lawUnknownProviderAlwaysRefused(fallbackEnabled: bool): bool =
  admitEdgeProvider(UnknownChoice, fallbackEnabled) == RefuseUnsupportedProvider
```

### Public article fetch validates canonical public URLs and batch bounds before dispatch

An anonymous `web_fetch` call requires 1 or 2 distinct canonical HTTP or HTTPS
public article URLs (no credentials, no loopback or private network hosts), a
bounded non-blank objective of 1 to 1000 characters, and an active non-aborted
caller signal.

```quint
type FetchBatch = { urlCount: int, distinctCount: int, allCanonicalPublic: bool, objectiveLen: int, aborted: bool }
pure val batchValues: Set[FetchBatch] = Set(
  { urlCount: 1, distinctCount: 1, allCanonicalPublic: true, objectiveLen: 64, aborted: false },
  { urlCount: 2, distinctCount: 2, allCanonicalPublic: true, objectiveLen: 120, aborted: false },
  { urlCount: 3, distinctCount: 3, allCanonicalPublic: true, objectiveLen: 64, aborted: false },
  { urlCount: 2, distinctCount: 1, allCanonicalPublic: true, objectiveLen: 64, aborted: false },
  { urlCount: 1, distinctCount: 1, allCanonicalPublic: false, objectiveLen: 64, aborted: false },
  { urlCount: 1, distinctCount: 1, allCanonicalPublic: true, objectiveLen: 64, aborted: true })
pure def canDispatchPublicFetch(batch: FetchBatch): bool =
  not(batch.aborted) and
  batch.urlCount >= 1 and batch.urlCount <= 2 and
  batch.distinctCount == batch.urlCount and
  batch.allCanonicalPublic and
  batch.objectiveLen >= 1 and batch.objectiveLen <= 1000
pure def lawAbortedFetchNeverDispatches(batch: FetchBatch): bool =
  batch.aborted implies not(canDispatchPublicFetch(batch))
pure def lawNonPublicOrDuplicateFetchRefused(batch: FetchBatch): bool =
  (not(batch.allCanonicalPublic) or batch.distinctCount != batch.urlCount or batch.urlCount > 2) implies not(canDispatchPublicFetch(batch))
```

### Provider outages stay distinct from zero-hit searches and prompt projections stay bounded

Every provider transport, HTTP, rate-limit, timeout, cancellation, size-limit,
content-type, or malformed-envelope failure is a typed outage, never an empty
result. Prompt-facing result digests bound the number of emitted snippets.

```quint
type KeylessOutcomeKind = OutcomeText | OutcomeZeroHits | OutcomeAborted | OutcomeTimeout | OutcomeNetwork | OutcomeRateLimited | OutcomeHttpError | OutcomeUnsupportedType | OutcomeResponseTooLarge | OutcomeProviderError | OutcomeMalformed
pure def isTypedProviderOutage(kind: KeylessOutcomeKind): bool =
  kind != OutcomeText and kind != OutcomeZeroHits
pure def lawTypedOutageNeverZeroHits(kind: KeylessOutcomeKind): bool =
  isTypedProviderOutage(kind) implies kind != OutcomeZeroHits
pure def compactSnippetLimit(total: int, maxSnippets: int): int =
  if (total <= 0 or maxSnippets <= 0) 0
  else if (total < maxSnippets) total
  else maxSnippets
pure def lawCompactSnippetLimitBounded(total: int, maxSnippets: int): bool =
  maxSnippets >= 0 implies compactSnippetLimit(total, maxSnippets) <= maxSnippets and compactSnippetLimit(total, maxSnippets) >= 0
```
