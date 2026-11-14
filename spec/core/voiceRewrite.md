# Outbound voice rewriting and shared cache

Source `security/voice-gate.ts` optionally rewrites finalized outbound text. Its cache is keyed by the exact agent id, source and FNV hash of originalText text. Hash computation remains the source pure algorithm contract. The historical hash collision behavior is preserved by this key definition. Every bio and voice-style directive remains in the rewrite prompt. Model rephrasing fidelity is an explicit external model boundary.

## Story: Reuse scoped rephrasing while retaining original text on failure

As an outbound transport, I want equivalent literals from the same agent and source to reuse their rewrite, and failed cosmetic rewriting to preserve the original deliverable.

### Cache hits move to most recent and capacity evicts only the oldest key

The process-wide cache retains at most 500 keys. A hit reinserts its key at the end. Setting a new key appends it; setting an existing key changes its value at the existing position. Scope includes agent and source, so different agents and surfaces use distinct cache entries.

```quint
type VoiceCacheKey = { agent: str, source: str, hash: str }
type VoiceCacheEntry = { key: VoiceCacheKey, text: str }
type RewritePhase = RewriteIdle | RewritePending | RewriteDone
type VoiceRewrite = { cache: List[VoiceCacheEntry], phase: RewritePhase, key: VoiceCacheKey, originalText: str, output: str, voiced: bool, errors: int }
pure val emptyKey: VoiceCacheKey = { agent: "", source: "", hash: "" }
pure val emptyEntry: VoiceCacheEntry = { key: emptyKey, text: "" }
pure val initial: VoiceRewrite = { cache: List(), phase: RewriteIdle, key: emptyKey, originalText: "", output: "", voiced: false, errors: 0 }
pure def cachedEntry(s: VoiceRewrite, key: VoiceCacheKey): VoiceCacheEntry = s.cache.select(entry => entry.key == key).nthOr(0, emptyEntry)
pure def cacheContains(s: VoiceRewrite, key: VoiceCacheKey): bool = s.cache.some(entry => entry.key == key)
pure def canBeginRewrite(s: VoiceRewrite): bool = s.phase != RewritePending
pure def beginRewrite(s: VoiceRewrite, key: VoiceCacheKey, originalText: str): VoiceRewrite = if (cacheContains(s, key)) { ...s, phase: RewriteDone, key: key, originalText: originalText, output: cachedEntry(s, key).text, voiced: true, cache: s.cache.select(entry => entry.key != key).append(cachedEntry(s, key)) } else { ...s, phase: RewritePending, key: key, originalText: originalText, output: originalText, voiced: false }
pure def canRewriteSuccess(s: VoiceRewrite, text: str): bool = s.phase == RewritePending and text != ""
pure def rewriteSuccess(s: VoiceRewrite, text: str): VoiceRewrite = {
  val entries = if (cacheContains(s, s.key)) s.cache.listMap(entry => if (entry.key == s.key) { key: s.key, text: text } else entry) else s.cache.append({ key: s.key, text: text })
  { ...s, phase: RewriteDone, output: text, voiced: true, cache: if (entries.length() > 500) entries.tail() else entries }
}
pure def canRewriteFailure(s: VoiceRewrite): bool = s.phase == RewritePending
pure def rewriteFailure(s: VoiceRewrite): VoiceRewrite = { ...s, phase: RewriteDone, output: s.originalText, voiced: false, errors: s.errors + 1 }
pure def alwaysCacheCapacityAndKeys(s: VoiceRewrite): bool = s.cache.length() <= 500 and s.cache.every(entry => s.cache.select(other => other.key == entry.key).length() == 1)
pure def alwaysPendingRetainsOriginal(s: VoiceRewrite): bool = s.phase == RewritePending implies s.output == s.originalText and not(s.voiced)
pure def stepFailureKeepsOriginal(before: VoiceRewrite, via: str, after: VoiceRewrite): bool = via == "rewriteFailure" implies after.output == before.originalText and not(after.voiced) and after.cache == before.cache
pure def sometimesCachedVoiceReturned(s: VoiceRewrite): bool = s.phase == RewriteDone and s.voiced
pure def sometimesFailureKeepsMessage(s: VoiceRewrite): bool = s.phase == RewriteDone and s.errors > 0 and not(s.voiced)
pure val keyValues = Set({ agent: "a1", source: "chat", hash: "h1" }, { agent: "a2", source: "chat", hash: "h1" }, { agent: "a1", source: "notice", hash: "h1" })
```

### Typed notices and existing voice provenance bypass cosmetic inference

A validated synthetic failure stays original. Reminder presentation must validate and its chat text must equal the content text, otherwise the call throws. Valid reminders strip the presentation marker and voiced flag. Valid system notices derive exact notice text and strip the voiced flag. A disabled rewrite setting, blank text, already-voiced content or missing model surface passes through. Model errors and blank normalized output report an error and preserve original content.

```quint
type VoiceDecision = SyntheticFailure | ValidReminder | InvalidReminder | ValidSystemNotice | RewriteDisabled | BlankText | AlreadyVoiced | ModelUnavailable | NeedsRewrite
pure def usesRewriteModel(decision: VoiceDecision): bool = decision == NeedsRewrite
pure def throwsVoiceBoundary(decision: VoiceDecision): bool = decision == InvalidReminder
pure def stripsVoiceFlag(decision: VoiceDecision): bool = decision == ValidReminder or decision == ValidSystemNotice
pure def lawInvalidReminderRejected(decision: VoiceDecision): bool = decision == InvalidReminder implies throwsVoiceBoundary(decision) and not(usesRewriteModel(decision))
pure def lawSyntheticFailureNeverRevoiced(decision: VoiceDecision): bool = decision == SyntheticFailure implies not(usesRewriteModel(decision))
```
