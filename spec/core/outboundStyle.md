# Outbound style rewriting

Source `security/voice-gate.ts` optionally rewrites finalized outbound text in the agent's persona style; it is not speech. Its cache key is the agent id, the source and the FNV hash of the original text, so two different texts whose hashes collide share one rewrite. Every bio and style directive stays in the rewrite prompt. How faithfully the model rephrases is an external model boundary.

## Story: Reuse scoped rephrasing while retaining original text on failure

> As an outbound transport, I want equal text from the same agent and
> source to reuse its rewrite, so that styling stays cheap, and a failed
> rewrite to deliver the original text, so that styling never loses a
> message.

### Cache hits move to most recent and capacity evicts only the oldest key

The process-wide cache retains at most 500 keys. A hit reinserts its key at the end. Setting a new key appends it; setting an existing key changes its value at the existing position. Scope includes agent and source, so different agents and surfaces use distinct cache entries. Calls hold distinct tickets, including simultaneous misses on the same key. Each returns its own normalized response, and successful completions update the shared cache in their actual settlement order. A late same-key completion replaces the value in its existing position. No model result can settle another call. A failure reports once per admitted call and returns that call's original content.

```quint
type StyleCacheKey = { agent: str, source: str, hash: str }
type StyleCacheEntry = { key: StyleCacheKey, text: str }
type RewritePhase = RewriteIdle | RewritePending | RewriteDone
type RewriteCall = { ticket: int, phase: RewritePhase, key: StyleCacheKey, originalText: str, output: str, styled: bool, cacheHit: bool, failed: bool }
type StyleRewrite = { cache: List[StyleCacheEntry], calls: List[RewriteCall], nextTicket: int, errors: int }
pure val emptyKey: StyleCacheKey = { agent: "", source: "", hash: "" }
pure val emptyEntry: StyleCacheEntry = { key: emptyKey, text: "" }
pure val completePhase: RewritePhase = RewriteDone
pure val pendingPhase: RewritePhase = RewritePending
pure val absentCall: RewriteCall = { ticket: 0, phase: RewriteIdle, key: emptyKey, originalText: "", output: "", styled: false, cacheHit: false, failed: false }
pure val initial: StyleRewrite = { cache: List(), calls: List(), nextTicket: 1, errors: 0 }
pure def cachedEntry(cache: List[StyleCacheEntry], key: StyleCacheKey): StyleCacheEntry = cache.select(entry => entry.key == key).nthOr(0, emptyEntry)
pure def cacheContains(cache: List[StyleCacheEntry], key: StyleCacheKey): bool = cache.some(entry => entry.key == key)
pure def touchCache(cache: List[StyleCacheEntry], key: StyleCacheKey): List[StyleCacheEntry] = cache.select(entry => entry.key != key).append(cachedEntry(cache, key))
pure def storeRewrite(cache: List[StyleCacheEntry], key: StyleCacheKey, text: str): List[StyleCacheEntry] = {
  val entries = if (cacheContains(cache, key)) cache.listMap(entry => if (entry.key == key) { key: key, text: text } else entry) else cache.append({ key: key, text: text })
  if (entries.length() > 500) entries.tail() else entries
}
pure def callAt(s: StyleRewrite, ticket: int): RewriteCall = s.calls.nthOr(ticket - 1, absentCall)
pure def pendingTicket(s: StyleRewrite, ticket: int): bool = ticket > 0 and ticket < s.nextTicket and callAt(s, ticket).phase == RewritePending
pure def beginRewrite(s: StyleRewrite, key: StyleCacheKey, originalText: str): StyleRewrite = {
  val hit = cacheContains(s.cache, key)
  val call: RewriteCall = { ticket: s.nextTicket, phase: if (hit) completePhase else pendingPhase, key: key, originalText: originalText, output: if (hit) cachedEntry(s.cache, key).text else originalText, styled: hit, cacheHit: hit, failed: false }
  { ...s, cache: if (hit) touchCache(s.cache, key) else s.cache, calls: s.calls.append(call), nextTicket: s.nextTicket + 1 }
}
pure def canSettleRewrite(s: StyleRewrite, ticket: int): bool = pendingTicket(s, ticket)
pure def settledCall(call: RewriteCall, normalizedText: str): RewriteCall = { ...call, phase: RewriteDone, output: if (normalizedText == "") call.originalText else normalizedText, styled: normalizedText != "", failed: normalizedText == "" }
pure def settleRewrite(s: StyleRewrite, ticket: int, normalizedText: str): StyleRewrite = { ...s, calls: s.calls.listMap(call => if (call.ticket == ticket) settledCall(call, normalizedText) else call), cache: if (normalizedText == "") s.cache else storeRewrite(s.cache, callAt(s, ticket).key, normalizedText), errors: s.errors + (if (normalizedText == "") 1 else 0) }
pure def oldestPending(s: StyleRewrite): int = s.calls.select(call => call.phase == RewritePending).nthOr(0, absentCall).ticket
pure def canSettleNext(s: StyleRewrite): bool = pendingTicket(s, oldestPending(s))
pure def settleNext(s: StyleRewrite, normalizedText: str): StyleRewrite = settleRewrite(s, oldestPending(s), normalizedText)
pure def alwaysCacheCapacityAndKeys(s: StyleRewrite): bool = s.cache.length() <= 500 and s.cache.every(entry => s.cache.select(other => other.key == entry.key).length() == 1)
pure def alwaysCallIdentityAtSlot(s: StyleRewrite): bool = s.nextTicket == s.calls.length() + 1 and s.calls.every(call => call.ticket > 0 and call.ticket < s.nextTicket and callAt(s, call.ticket) == call and s.calls.select(other => other.ticket == call.ticket).length() == 1)
pure def alwaysPendingOrFailureRetainsOriginal(s: StyleRewrite): bool = s.calls.every(call => (call.phase == RewritePending or call.failed) implies call.output == call.originalText and not(call.styled))
pure def stepCompletedCallIsImmutable(before: StyleRewrite, after: StyleRewrite): bool = before.calls.every(call => call.phase != RewriteDone or callAt(after, call.ticket) == call)
pure def stepFailurePreservesSharedCache(before: StyleRewrite, after: StyleRewrite): bool = after.errors == before.errors or (after.errors == before.errors + 1 and after.cache == before.cache)
pure def sometimesCachedStyleReturned(s: StyleRewrite): bool = s.calls.some(call => call.cacheHit and call.styled)
pure def sometimesFailureKeepsMessage(s: StyleRewrite): bool = s.calls.some(call => call.failed and call.output == call.originalText)
pure def sometimesSimultaneousSameKeyMisses(s: StyleRewrite): bool = s.calls.some(a => a.phase == RewritePending and s.calls.some(b => b.phase == RewritePending and a.ticket != b.ticket and a.key == b.key))
pure val fair_settleNext = "weak"
pure def leadsToAdmittedCallsSettle(s: StyleRewrite, later: StyleRewrite): bool = s.calls.every(call => callAt(later, call.ticket).phase == RewriteDone)
pure val keyValues = Set({ agent: "a1", source: "chat", hash: "h1" }, { agent: "a2", source: "chat", hash: "h1" }, { agent: "a1", source: "notice", hash: "h1" })
pure val ticketValues = Set(1, 2, 3, 4)
pure val normalizedTextValues = Set("", "first style", "second style")
```

### Typed notices and already-styled content bypass the rewrite model

The checks run in this order. A validated synthetic failure stays original.
A reminder must validate and its chat text must equal the content text,
otherwise the call throws; a valid reminder strips the presentation marker
and the styled flag. A valid system notice derives its exact notice text
and strips the styled flag. A disabled rewrite setting, blank text, content
already marked as styled (the source's `voiced` flag) or a missing model
surface passes through. Only content past every check reaches the rewrite
model, whose errors and blank output report an error and keep the original
content.

```quint
type StyleDecision = SyntheticFailure | ValidReminder | InvalidReminder | ValidSystemNotice | RewriteDisabled | BlankText | AlreadyStyled | ModelUnavailable | NeedsRewrite
type StyleInput = { syntheticFailure: bool, reminder: bool, reminderValid: bool, systemNotice: bool, enabled: bool, blank: bool, alreadyStyled: bool, modelAvailable: bool }
pure def styleDecision(input: StyleInput): StyleDecision =
  if (input.syntheticFailure) SyntheticFailure
  else if (input.reminder) (if (input.reminderValid) ValidReminder else InvalidReminder)
  else if (input.systemNotice) ValidSystemNotice
  else if (not(input.enabled)) RewriteDisabled
  else if (input.blank) BlankText
  else if (input.alreadyStyled) AlreadyStyled
  else if (not(input.modelAvailable)) ModelUnavailable
  else NeedsRewrite
pure def lawOnlyUntypedUnstyledTextIsRewritten(input: StyleInput): bool =
  (styleDecision(input) == NeedsRewrite) iff (not(input.syntheticFailure) and not(input.reminder) and not(input.systemNotice) and input.enabled and not(input.blank) and not(input.alreadyStyled) and input.modelAvailable)
pure def lawOnlyAnInvalidReminderThrows(input: StyleInput): bool =
  (styleDecision(input) == InvalidReminder) iff (not(input.syntheticFailure) and input.reminder and not(input.reminderValid))
pure val plain: StyleInput = { syntheticFailure: false, reminder: false, reminderValid: false, systemNotice: false, enabled: true, blank: false, alreadyStyled: false, modelAvailable: true }
pure val inputValues = Set(plain, { ...plain, syntheticFailure: true, reminder: true }, { ...plain, reminder: true }, { ...plain, reminder: true, reminderValid: true }, { ...plain, systemNotice: true }, { ...plain, enabled: false }, { ...plain, blank: true }, { ...plain, alreadyStyled: true }, { ...plain, modelAvailable: false })
```
