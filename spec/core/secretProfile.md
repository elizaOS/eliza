# Runtime configured-secret profile identity

The source is `packages/core/src/runtime.ts:4479-4505`, with eligibility constants from `security/redact.ts:27`, at the pinned baseline. The runtime caches the SHA-256 signature of the sorted, deduplicated, eligible configured-secret values and a monotonic revision. This module represents signature equality by equality of its canonical preimage set. Hashing, UTF-16 lengths and configured-credential classification are exact input boundaries; cryptographic collision resistance is an explicit assumption. Names, value order and duplicate values do not participate in that preimage. `declassifyProfileRevision` releases only the source-defined monotonic change metadata, never configured secret values.

## Story: Invalidate fragment taint only when its secret profile changes

A host receiving fragment taint also receives the runtime-local profile revision. The first query initializes revision one even when there are no eligible secrets. Every change to the eligible value set increments it. Repeated queries and changes only to ineligible short or noncredential values retain it.

### The first query initializes the canonical signature and later changes advance it

```quint
type ConfiguredSecret = { value: str, utf16Length: int, credential: bool }
type SecretProfile = { initialized: bool, signatureValues: Set[str], revision: int }
pure val initial: SecretProfile = { initialized: false, signatureValues: Set(), revision: 0 }
pure val configuredValues = Set(List(), List({ value: "credentialA", utf16Length: 11, credential: true }), List({ value: "credentialA", utf16Length: 11, credential: true }, { value: "credentialA", utf16Length: 11, credential: true }), List({ value: "tiny", utf16Length: 4, credential: true }), List({ value: "model-config", utf16Length: 12, credential: false }))
pure def eligibleValues(configured: List[ConfiguredSecret]): Set[str] = configured.foldl(Set(), (values, entry) => if (entry.credential and entry.utf16Length >= 8) values.union(Set(entry.value)) else values)
pure def sameValues(left: Set[str], right: Set[str]): bool = left.subseteq(right) and right.subseteq(left)
pure def declassifyProfileRevision(s: SecretProfile, configured: List[ConfiguredSecret]): int = if (not(s.initialized) or not(sameValues(eligibleValues(configured), s.signatureValues))) s.revision + 1 else s.revision
pure def observe(s: SecretProfile, configured: List[ConfiguredSecret]): SecretProfile = {
  val normalized = eligibleValues(configured)
  { initialized: true, signatureValues: normalized, revision: declassifyProfileRevision(s, configured) }
}
pure def alwaysProfileRevisionHasInitialization(s: SecretProfile): bool = (s.initialized and s.revision > 0) or (not(s.initialized) and s.revision == 0 and s.signatureValues.size() == 0)
pure def stepProfileRevisionAdvancesAtMostOnce(before: SecretProfile, via: str, after: SecretProfile): bool = via != "observe" or after.revision == before.revision or after.revision == before.revision + 1
pure def lawEquivalentConfiguredValuesRetainRevision(s: SecretProfile, configured: List[ConfiguredSecret]): bool = s.initialized and sameValues(s.signatureValues, eligibleValues(configured)) implies observe(s, configured).revision == s.revision
pure def lawChangedConfiguredValuesAdvanceRevision(s: SecretProfile, configured: List[ConfiguredSecret]): bool = not(s.initialized) or not(sameValues(s.signatureValues, eligibleValues(configured))) implies observe(s, configured).revision == s.revision + 1
pure def sometimesEmptyProfileIsInitialized(s: SecretProfile): bool = s.initialized and s.revision > 0 and s.signatureValues.size() == 0
```
