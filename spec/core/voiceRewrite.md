# Outbound voice rewriting and shared cache

Source `security/voice-gate.ts` optionally rewrites finalized outbound text. Its cache is keyed by the exact agent id, source and FNV hash of the original text. Hash computation remains the source pure algorithm contract. The historical hash collision behavior is preserved by this key definition. Every bio and voice-style directive remains in the rewrite prompt. Model rephrasing fidelity is an explicit external model boundary.

## Story: Reuse scoped rephrasing while retaining original text on failure

As an outbound transport, I want equivalent literals from the same agent and source to reuse their rewrite, and failed cosmetic rewriting to preserve the original deliverable.

### Cache hits move to most recent and capacity evicts only the oldest key

The process-wide cache retains at most 500 keys. A hit reinserts its key at the end. Setting a new key appends it; setting an existing key changes its value at the existing position. Scope includes agent and source, so different agents and surfaces use distinct cache entries. Calls hold distinct tickets, including simultaneous misses on the same key. Each returns its own normalized response, and successful completions update the shared cache in their actual settlement order. A late same-key completion replaces the value in its existing position. No model result can settle another call. A failure reports once per admitted call and returns that call's original content.

```quint
type VoiceCacheKey = { agent: str, source: str, hash: str }
type VoiceCacheEntry = { key: VoiceCacheKey, text: str }
type RewritePhase = RewriteIdle | RewritePending | RewriteDone
type RewriteCall = { ticket: int, phase: RewritePhase, key: VoiceCacheKey, originalText: str, output: str, voiced: bool, cacheHit: bool, failed: bool }
type VoiceRewrite = { cache: List[VoiceCacheEntry], calls: List[RewriteCall], nextTicket: int, errors: int }
pure val emptyKey: VoiceCacheKey = { agent: "", source: "", hash: "" }
pure val emptyEntry: VoiceCacheEntry = { key: emptyKey, text: "" }
pure val completePhase: RewritePhase = RewriteDone
pure val pendingPhase: RewritePhase = RewritePending
pure val absentCall: RewriteCall = { ticket: 0, phase: RewriteIdle, key: emptyKey, originalText: "", output: "", voiced: false, cacheHit: false, failed: false }
pure val initial: VoiceRewrite = { cache: List(), calls: List(), nextTicket: 1, errors: 0 }
pure def cachedEntry(cache: List[VoiceCacheEntry], key: VoiceCacheKey): VoiceCacheEntry = cache.select(entry => entry.key == key).nthOr(0, emptyEntry)
pure def cacheContains(cache: List[VoiceCacheEntry], key: VoiceCacheKey): bool = cache.some(entry => entry.key == key)
pure def touchCache(cache: List[VoiceCacheEntry], key: VoiceCacheKey): List[VoiceCacheEntry] = cache.select(entry => entry.key != key).append(cachedEntry(cache, key))
pure def storeRewrite(cache: List[VoiceCacheEntry], key: VoiceCacheKey, text: str): List[VoiceCacheEntry] = {
  val entries = if (cacheContains(cache, key)) cache.listMap(entry => if (entry.key == key) { key: key, text: text } else entry) else cache.append({ key: key, text: text })
  if (entries.length() > 500) entries.tail() else entries
}
pure def callAt(s: VoiceRewrite, ticket: int): RewriteCall = s.calls.nthOr(ticket - 1, absentCall)
pure def pendingTicket(s: VoiceRewrite, ticket: int): bool = ticket > 0 and ticket < s.nextTicket and callAt(s, ticket).phase == RewritePending
pure def beginRewrite(s: VoiceRewrite, key: VoiceCacheKey, originalText: str): VoiceRewrite = {
  val hit = cacheContains(s.cache, key)
  val call: RewriteCall = { ticket: s.nextTicket, phase: if (hit) completePhase else pendingPhase, key: key, originalText: originalText, output: if (hit) cachedEntry(s.cache, key).text else originalText, voiced: hit, cacheHit: hit, failed: false }
  { ...s, cache: if (hit) touchCache(s.cache, key) else s.cache, calls: s.calls.append(call), nextTicket: s.nextTicket + 1 }
}
pure def canSettleRewrite(s: VoiceRewrite, ticket: int): bool = pendingTicket(s, ticket)
pure def settledCall(call: RewriteCall, normalizedText: str): RewriteCall = { ...call, phase: RewriteDone, output: if (normalizedText == "") call.originalText else normalizedText, voiced: normalizedText != "", failed: normalizedText == "" }
pure def settleRewrite(s: VoiceRewrite, ticket: int, normalizedText: str): VoiceRewrite = { ...s, calls: s.calls.listMap(call => if (call.ticket == ticket) settledCall(call, normalizedText) else call), cache: if (normalizedText == "") s.cache else storeRewrite(s.cache, callAt(s, ticket).key, normalizedText), errors: s.errors + (if (normalizedText == "") 1 else 0) }
pure def oldestPending(s: VoiceRewrite): int = s.calls.select(call => call.phase == RewritePending).nthOr(0, absentCall).ticket
pure def canSettleNext(s: VoiceRewrite): bool = pendingTicket(s, oldestPending(s))
pure def settleNext(s: VoiceRewrite, normalizedText: str): VoiceRewrite = settleRewrite(s, oldestPending(s), normalizedText)
pure def alwaysCacheCapacityAndKeys(s: VoiceRewrite): bool = s.cache.length() <= 500 and s.cache.every(entry => s.cache.select(other => other.key == entry.key).length() == 1)
pure def alwaysCallIdentityAtSlot(s: VoiceRewrite): bool = s.nextTicket == s.calls.length() + 1 and s.calls.every(call => call.ticket > 0 and call.ticket < s.nextTicket and callAt(s, call.ticket) == call and s.calls.select(other => other.ticket == call.ticket).length() == 1)
pure def alwaysPendingOrFailureRetainsOriginal(s: VoiceRewrite): bool = s.calls.every(call => (call.phase == RewritePending or call.failed) implies call.output == call.originalText and not(call.voiced))
pure def stepCompletedCallIsImmutable(before: VoiceRewrite, after: VoiceRewrite): bool = before.calls.every(call => call.phase != RewriteDone or callAt(after, call.ticket) == call)
pure def stepFailurePreservesSharedCache(before: VoiceRewrite, after: VoiceRewrite): bool = after.errors == before.errors or (after.errors == before.errors + 1 and after.cache == before.cache)
pure def sometimesCachedVoiceReturned(s: VoiceRewrite): bool = s.calls.some(call => call.cacheHit and call.voiced)
pure def sometimesFailureKeepsMessage(s: VoiceRewrite): bool = s.calls.some(call => call.failed and call.output == call.originalText)
pure def sometimesSimultaneousSameKeyMisses(s: VoiceRewrite): bool = s.calls.some(a => a.phase == RewritePending and s.calls.some(b => b.phase == RewritePending and a.ticket != b.ticket and a.key == b.key))
pure val fair_settleNext = "weak"
pure def leadsToAdmittedCallsSettle(s: VoiceRewrite, later: VoiceRewrite): bool = s.calls.every(call => callAt(later, call.ticket).phase == RewriteDone)
pure val keyValues = Set({ agent: "a1", source: "chat", hash: "h1" }, { agent: "a2", source: "chat", hash: "h1" }, { agent: "a1", source: "notice", hash: "h1" })
pure val ticketValues = Set(1, 2, 3, 4)
pure val normalizedTextValues = Set("", "first voice", "second voice")
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
