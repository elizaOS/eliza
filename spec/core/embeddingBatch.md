# Batch embedding fallback ordering

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. The baseline `EmbeddingWriteSettlement.qnt` preserves primary batch order and defers per-item retries until all primary items settle. Each item's source and receipt lifecycle is specified by [Embedding write settlement](./embeddingWrite.md). This coordinator owns only batch admission, primary completion and fallback readiness.

## Story: Finish the primary batch before retrying individual items

As an agent, I can fall back to single-item embedding without racing unfinished primary writes. Each failed primary item can acquire one fallback owner, and each successful primary item becomes complete without fallback.

### A batch owns a finite supplied member set without a fixed size limit

```quint
type Batch = { admitted: bool, members: Set[str], primaryDone: Set[str], retryable: Set[str], retrying: Set[str], completed: Set[str] }
pure val initial: Batch = { admitted: false, members: Set(), primaryDone: Set(), retryable: Set(), retrying: Set(), completed: Set() }
pure val membersValues = Set(Set(), Set("item1"), Set("item1", "item2"), Set("item1", "item2", "item3"))
pure val idValues = Set("item1", "item2", "item3", "unknown")
pure def canAdmit(s: Batch, members: Set[str]): bool = not(s.admitted)
pure def admit(s: Batch, members: Set[str]): Batch = { ...s, admitted: true, members: members }
pure def canPrimaryResult(s: Batch, id: str, succeeded: bool): bool = s.admitted and s.members.contains(id) and not(s.primaryDone.contains(id))
pure def primaryResult(s: Batch, id: str, succeeded: bool): Batch = { ...s, primaryDone: s.primaryDone.union(Set(id)), retryable: if (succeeded) s.retryable else s.retryable.union(Set(id)), completed: if (succeeded) s.completed.union(Set(id)) else s.completed }
```

### A fallback owner starts only after every primary outcome is known

```quint
pure def canFallback(s: Batch, id: str): bool = s.members.subseteq(s.primaryDone) and s.retryable.contains(id) and not(s.retrying.contains(id)) and not(s.completed.contains(id))
pure def fallback(s: Batch, id: str): Batch = { ...s, retrying: s.retrying.union(Set(id)) }
pure def canFallbackResult(s: Batch, id: str): bool = s.retrying.contains(id)
pure def fallbackResult(s: Batch, id: str): Batch = { ...s, retrying: s.retrying.exclude(Set(id)), retryable: s.retryable.exclude(Set(id)), completed: s.completed.union(Set(id)) }
pure def alwaysOutcomesBelongToMembers(s: Batch): bool = s.primaryDone.subseteq(s.members) and s.retryable.subseteq(s.primaryDone) and s.retrying.subseteq(s.retryable) and s.completed.subseteq(s.primaryDone)
pure def alwaysFallbackWaitsForPrimary(s: Batch): bool = s.retrying.size() == 0 or s.members.subseteq(s.primaryDone)
pure def alwaysCompletedItemsHaveNoRetryOwner(s: Batch): bool = s.completed.intersect(s.retrying).size() == 0
pure def sometimesBatchFallbackCompletes(s: Batch): bool = s.members.size() > 1 and s.members.subseteq(s.completed)
pure val fair_primaryResult = "weak"
pure val fair_fallback = "weak"
pure val fair_fallbackResult = "weak"
pure def leadsToBatchSettles(s: Batch, later: Batch): bool = s.admitted implies later.members.subseteq(later.completed)
```
