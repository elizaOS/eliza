# One-time challenges

The identity service keeps short-lived one-time challenges (email codes, SMS
codes, OAuth states and App Link codes) in a shared store. Each challenge
belongs to one purpose, and the store offers three atomic operations on it:
publish a token, consume that token once, and revoke a claim by
compare-and-delete. [Code sign-in](./codeSignIn.md),
[Google sign-in](./googleSignIn.md) and [request integrity](./requestIntegrity.md)
keep their codes, states and nonces here; each states the single-use rule
of its own flow. Every backend treats an expired row as absent, so
physical cleanup of expired rows is not modeled.

## Story: Publish, consume and revoke one-time challenges

> As the identity service, I want each one-time challenge to have exactly one
> publisher and to be consumed at most once before it expires, so that a code
> or state can never be replayed, raced or revived.

### A challenge opens once per purpose and lives for a fixed time

A challenge starts available (claim 0). A revoked claim is -1, and a positive
claim names the publisher that owns it.

```quint
type Challenge = { purpose: str, claim: int, issuer: int, live: bool, consumed: bool, expiresAt: int }
type ChallengeStore = { now: int, challenges: List[Challenge] }
pure val initial: ChallengeStore = { now: 0, challenges: List() }
pure val challengeLifetime = 3
pure val noChallenge: Challenge = { purpose: "", claim: -1, issuer: 0, live: false, consumed: false, expiresAt: 0 }
pure def challengeFor(s: ChallengeStore, purpose: str): Challenge = s.challenges.select(c => c.purpose == purpose).nthOr(0, noChallenge)
pure def hasChallenge(s: ChallengeStore, purpose: str): bool = s.challenges.some(c => c.purpose == purpose)
pure def unexpired(s: ChallengeStore, purpose: str): bool = hasChallenge(s, purpose) and s.now < challengeFor(s, purpose).expiresAt
pure def canOpenChallenge(s: ChallengeStore, purpose: str): bool = purpose != "" and not(hasChallenge(s, purpose))
pure def openChallenge(s: ChallengeStore, purpose: str): ChallengeStore =
  { ...s, challenges: s.challenges.append({ purpose: purpose, claim: 0, issuer: 0, live: false, consumed: false, expiresAt: s.now + challengeLifetime }) }
pure def elapse(s: ChallengeStore): ChallengeStore = { ...s, now: s.now + 1 }
pure def alwaysOneChallengePerPurpose(s: ChallengeStore): bool = s.challenges.every(c => s.challenges.select(o => o.purpose == c.purpose).length() == 1)
pure val purposeValues = Set("email-code", "oauth-state")
pure val ownerValues = Set(1, 2)
```

### Only the first publisher's token is issued; a competing publisher is refused

Publishing again with the owner's own claim is an acknowledged replay: it
reapplies nothing, so a token consumed after the first publication stays
consumed.

```quint
pure def canPublish(s: ChallengeStore, purpose: str, owner: int): bool = {
  val c = challengeFor(s, purpose)
  owner > 0 and unexpired(s, purpose) and (c.claim == 0 or c.claim == owner)
}
pure def publish(s: ChallengeStore, purpose: str, owner: int): ChallengeStore =
  { ...s, challenges: s.challenges.listMap(c => if (c.purpose == purpose and c.claim == 0) { ...c, claim: owner, issuer: owner, live: true } else c) }
pure def alwaysOnePublisherPerChallenge(s: ChallengeStore): bool =
  s.challenges.every(c => (c.claim == 0 implies (c.issuer == 0 and not(c.live) and not(c.consumed))) and (c.issuer != 0 implies (c.claim == c.issuer or c.claim == -1)) and c.claim >= -1)
pure def sometimesPublishedBeforeExpiry(s: ChallengeStore): bool = s.challenges.some(c => c.issuer == 1 and c.live and s.now < c.expiresAt)
```

### A token is consumed at most once and never comes back

```quint
pure def canConsume(s: ChallengeStore, purpose: str, owner: int): bool = {
  val c = challengeFor(s, purpose)
  unexpired(s, purpose) and c.live and c.issuer == owner
}
pure def consume(s: ChallengeStore, purpose: str, owner: int): ChallengeStore =
  { ...s, challenges: s.challenges.listMap(c => if (c.purpose == purpose) { ...c, live: false, consumed: true } else c) }
pure def alwaysConsumedTokenStaysAbsent(s: ChallengeStore): bool =
  s.challenges.every(c => (c.consumed implies not(c.live)) and ((c.live or c.consumed) implies c.issuer > 0))
pure def stepConsumedNeverRevives(before: ChallengeStore, after: ChallengeStore): bool =
  before.challenges.every(b => not(b.consumed) or after.challenges.some(a => a.purpose == b.purpose and a.consumed and not(a.live)))
pure def sometimesConsumedThenReplayed(s: ChallengeStore): bool = s.challenges.some(c => c.consumed and c.claim == c.issuer)
```

### A revoked claim cannot publish again

Revocation is a compare-and-delete: it succeeds only for the owner of the
current claim.

```quint
pure def canRevoke(s: ChallengeStore, purpose: str, owner: int): bool = owner > 0 and unexpired(s, purpose) and challengeFor(s, purpose).claim == owner
pure def revoke(s: ChallengeStore, purpose: str, owner: int): ChallengeStore =
  { ...s, challenges: s.challenges.listMap(c => if (c.purpose == purpose) { ...c, claim: -1 } else c) }
pure def stepRevokedClaimStaysRevoked(before: ChallengeStore, after: ChallengeStore): bool =
  before.challenges.every(b => b.claim != -1 or after.challenges.some(a => a.purpose == b.purpose and a.claim == -1 and a.issuer == b.issuer))
pure def sometimesRevokedAfterPublication(s: ChallengeStore): bool = s.challenges.some(c => c.claim == -1 and c.issuer > 0)
```

### An expired challenge refuses every operation

```quint
pure def stepExpiredChallengeIsFrozen(before: ChallengeStore, after: ChallengeStore): bool =
  before.challenges.every(c => before.now < c.expiresAt or after.challenges.includes(c))
pure def sometimesExpiredUnpublished(s: ChallengeStore): bool = s.challenges.some(c => c.claim == 0 and s.now >= c.expiresAt)
```

### Purposes are isolated: an operation changes at most one challenge

```quint
pure def stepOneChallengeChanges(before: ChallengeStore, after: ChallengeStore): bool =
  after.challenges.select(c => not(before.challenges.includes(c))).length() <= 1
pure def sometimesTwoPurposesLive(s: ChallengeStore): bool = s.challenges.select(c => c.live).length() == 2
```
