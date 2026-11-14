# Pairing reply retention

This model migrates `PairingReplyWindow` from `quint/PairingAdmission.qnt`. Source `services/pairing.ts` retains a process-local map of last reply timestamps for each channel/sender tuple. Each service belongs to one agent. Retention is independent of the durable request table.

## Story: Suppress repeated pairing replies within the retained TTL

As an owner, I want a sender's repeated first messages to consume one reply claim until expiry or bounded-cache eviction.

### A live retained claim suppresses a reply and expired claims can rearm it

The source retains up to 4096 claims. At capacity, claiming first sweeps expired entries and then evicts oldest survivors until a new entry fits. Updating an existing expired key retains its insertion position. Expiry is `now - claimedAt >= ttl`, and wall-clock changes keep the source's elapsed arithmetic. The model parameter `capacity` is configured once so the exact 4096 production bound and smaller exhaustive scenarios use the same transition.

```quint
type ReplyScope = { channel: str, sender: str }
type ReplyClaim = { scope: ReplyScope, claimedAt: int }
type PairingReplies = { configured: bool, capacity: int, ttl: int, retained: List[ReplyClaim], accepted: bool, wasLive: bool }
pure val initial: PairingReplies = { configured: false, capacity: 4096, ttl: 3600000, retained: List(), accepted: false, wasLive: false }
pure def canConfigure(s: PairingReplies, capacity: int): bool = not(s.configured) and capacity > 0
pure def configure(s: PairingReplies, capacity: int, ttl: int): PairingReplies = { ...s, configured: true, capacity: capacity, ttl: ttl }
pure def canClaim(s: PairingReplies): bool = s.configured
pure def liveClaims(s: PairingReplies, now: int): List[ReplyClaim] = s.retained.select(entry => now - entry.claimedAt < s.ttl)
pure def boundedClaims(entries: List[ReplyClaim], capacity: int): List[ReplyClaim] = if (entries.length() > 0 and entries.length() >= capacity) entries.tail() else entries
pure def refreshedClaims(entries: List[ReplyClaim], scope: ReplyScope, now: int): List[ReplyClaim] =
  if (entries.some(entry => entry.scope == scope)) entries.listMap(entry => if (entry.scope == scope) { scope: scope, claimedAt: now } else entry) else entries.append({ scope: scope, claimedAt: now })
pure def claim(s: PairingReplies, scope: ReplyScope, now: int): PairingReplies = {
  val live = s.retained.some(entry => entry.scope == scope and now - entry.claimedAt < s.ttl)
  val swept = if (s.retained.length() >= s.capacity) liveClaims(s, now) else s.retained
  val updated = refreshedClaims(boundedClaims(swept, s.capacity), scope, now)
  if (live) { ...s, accepted: false, wasLive: true } else { ...s, retained: updated, accepted: true, wasLive: false }
}
pure def alwaysReplyCacheBound(s: PairingReplies): bool = s.capacity > 0 and s.retained.length() <= s.capacity
pure def alwaysUnconfiguredIsEmpty(s: PairingReplies): bool = not(s.configured) implies s.retained.length() == 0
pure def alwaysUniqueReplyScopes(s: PairingReplies): bool = s.retained.every(entry => s.retained.select(other => other.scope == entry.scope).length() == 1)
pure def alwaysLiveClaimSuppresses(s: PairingReplies): bool = s.wasLive implies not(s.accepted)
pure def sometimesRepeatedReplySuppressed(s: PairingReplies): bool = s.wasLive
pure def sometimesReplyClaimed(s: PairingReplies): bool = s.accepted
pure val scopeValues = Set({ channel: "chat", sender: "one" }, { channel: "chat", sender: "two" }, { channel: "mail", sender: "one" })
pure val capacityValues = Set(1, 2, 4096)
pure val ttlValues = Set(0, 1, 3600000)
pure val nowValues = Set(0, 1, 2, 3600000, 3600001)
```
