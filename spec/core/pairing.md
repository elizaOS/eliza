# Pairing admission and identity

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/pairing.ts`, `types/pairing.ts`, PairingAdmission and PairingIdentity. Request, allowlist and reply identities use canonical agent, channel and sender tuples. Expired requests do not count as live admission. Reply suppression is bounded and does not confer authorization. This machine follows one request's durable grant and consumption. The legacy models retain the multi-sender admission cap and reply-cache eviction interleavings.

## Story: Approve pairing without losing a failed request

As an owner, I grant a sender access and consume its request only after the grant is durable. A failed grant retains the code for retry. A failed consumption retains both the durable grant and the request. A retry reuses the actual stored grant identity.

### A request keeps the complete sender identity

```quint
type Sender = { agentId: str, channel: str, senderId: str }
pure val leftValues = Set({ agentId: "agent1", channel: "direct", senderId: "sender1" }, { agentId: "agent2", channel: "room", senderId: "sender2" })
pure val rightValues = leftValues
pure def sameSender(left: Sender, right: Sender): bool = left == right
pure def lawDifferentAgentsStayIndependent(left: Sender, right: Sender): bool = left.agentId != right.agentId implies not(sameSender(left, right))
pure def lawDifferentChannelsStayIndependent(left: Sender, right: Sender): bool = left.channel != right.channel implies not(sameSender(left, right))
pure def lawDifferentSendersStayIndependent(left: Sender, right: Sender): bool = left.senderId != right.senderId implies not(sameSender(left, right))
type PairingPhase = Pending | Granting | Consuming | Complete
type Pairing = { phase: PairingPhase, requestPresent: bool, grantPresent: bool, failed: bool, accepted: bool, grantIdentity: str, reportedIdentity: str }
pure val initial: Pairing = { phase: Pending, requestPresent: true, grantPresent: false, failed: false, accepted: false, grantIdentity: "", reportedIdentity: "" }
pure def canApprove(s: Pairing): bool = s.phase == Pending and s.requestPresent
pure def approve(s: Pairing): Pairing = { ...s, phase: Granting, failed: false }
```

### Grant persistence must succeed before consuming a request

```quint
pure def canGrant(s: Pairing, succeeded: bool, identity: str): bool = s.phase == Granting and (not(succeeded) or identity != "")
pure def grant(s: Pairing, succeeded: bool, identity: str): Pairing =
  if (succeeded) { ...s, phase: Consuming, grantPresent: true, grantIdentity: if (s.grantPresent) s.grantIdentity else identity }
  else { ...s, phase: Pending, failed: true }
pure val identityValues = Set("grant1", "grant2")
pure def canConsume(s: Pairing, succeeded: bool): bool = s.phase == Consuming and s.grantPresent
pure def consume(s: Pairing, succeeded: bool): Pairing =
  if (succeeded) { ...s, phase: Complete, requestPresent: false, accepted: true, reportedIdentity: s.grantIdentity }
  else { ...s, phase: Pending, failed: true }
pure def alwaysConsumptionFollowsGrant(s: Pairing): bool = not(s.requestPresent) implies s.grantPresent
pure def alwaysSuccessUsesStoredIdentity(s: Pairing): bool = s.accepted implies (s.grantPresent and s.reportedIdentity == s.grantIdentity and s.grantIdentity != "")
pure def alwaysGrantFailureRetainsCode(s: Pairing): bool = not(s.grantPresent) implies s.requestPresent
pure def stepExistingGrantIdentityIsStable(before: Pairing, after: Pairing): bool = not(before.grantPresent) or before.grantIdentity == after.grantIdentity
pure def sometimesPairingComplete(s: Pairing): bool = s.accepted and not(s.requestPresent)
pure def sometimesConsumptionCanRetry(s: Pairing): bool = s.phase == Pending and s.grantPresent and s.failed
```

### A retried request completes when storage eventually accepts both operations

This is the legacy conditional retry obligation. Weak fairness assumes a
pending request is retried; strong fairness on the success branches assumes
storage eventually acknowledges each repeatedly attempted grant and consume.
Failures alone cannot consume the request or fabricate a grant.

```quint
pure def canGrantAcknowledged(s: Pairing, identity: str): bool = canGrant(s, true, identity)
pure def grantAcknowledged(s: Pairing, identity: str): Pairing = grant(s, true, identity)
pure def canConsumptionAcknowledged(s: Pairing): bool = canConsume(s, true)
pure def consumptionAcknowledged(s: Pairing): Pairing = consume(s, true)
pure val fair_approve = "weak"
pure val fair_grantAcknowledged = "strong"
pure val fair_consumptionAcknowledged = "strong"
pure def leadsToRetriedRequestConsumed(s: Pairing, later: Pairing): bool = s.requestPresent implies not(later.requestPresent)
```
