// One promo-grant provenance stamp compared with the primary's locked policy.
// Accepting a null lifetime expiry validates shape, never independent authority.
module GrantPolicyStampAdmission {
 type State = { now: int, until: int, revoked: bool, generation: int,
   cache: bool, cachedGeneration: int, shape: bool, corrupted: bool,
   accepted: int, acceptedQualified: bool }
 var s: State
 action initialize(until: int, now: int): bool = s' = {
   now: now, until: until, revoked: false, generation: 0,
   cache: true, cachedGeneration: 0, shape: true, corrupted: false,
   accepted: 0, acceptedQualified: true }
 action init = any { initialize(-1, 0), initialize(-1, 1),
   initialize(2, 0), initialize(2, 1) }
 val windowLive = s.now >= 1 and (s.until == -1 or s.now < s.until)
 val stampValid = s.cache and s.shape and windowLive
 val primaryGrantLive = not(s.revoked) and windowLive
 val matchesPrimary = primaryGrantLive and s.cachedGeneration == s.generation
 action admit = all { stampValid, matchesPrimary, s.accepted < 2,
   s' = s.with("accepted", s.accepted + 1).with("acceptedQualified", primaryGrantLive) }
 action revoke = all { not(s.revoked),
   s' = s.with("revoked", true).with("generation", 1) }
 action tick = all { s.now < 3, s' = s.with("now", s.now + 1) }
 action corrupt = all { not(s.corrupted),
   s' = s.with("corrupted", true).with("shape", false) }
 // Refresh reads the primary. A revoked grant cannot be refreshed as promo authority.
 action refresh = s' = s.with("cache", primaryGrantLive)
   .with("cachedGeneration", s.generation).with("shape", true)
 action step = any { admit, revoke, tick, corrupt, refresh, s' = s }
 val TypeOK = s.now.in(0.to(3)) and s.until.in(Set(-1, 2))
   and s.generation.in(0.to(1)) and s.cachedGeneration.in(0.to(1))
   and s.accepted.in(0.to(2))
 val GrantAdmissionHadPrimaryAuthority = s.acceptedQualified
 val BeforeStartIsInvalid = s.now < 1 implies not(stampValid)
 val FiniteExpiryIsInvalid = s.until != -1 and s.now >= s.until implies not(stampValid)
 val LifetimeShapeSurvivesTime = s.until == -1 and s.now >= 1 and s.cache and s.shape implies stampValid
 temporal RevocationFencesNewAdmission = always((s.revoked implies
   next(s.accepted) == s.accepted).orKeep(s))
 temporal ExpiryFencesNewAdmission = always((s.until != -1 and s.now >= s.until implies
   next(s.accepted) == s.accepted).orKeep(s))
 temporal ActiveLifetimeSettles = (s.until == -1 and primaryGrantLive).leadsTo(s.accepted > 0 or s.revoked)
 temporal FairActiveLifetimeSettles = (refresh.weakFair(s) and admit.weakFair(s)) implies ActiveLifetimeSettles
 run lifetimeAfterFiniteHorizonTest = initialize(-1, 1).then(tick).then(tick)
   .then(admit).expect(stampValid and s.accepted == 1)
 run expiredFiniteStampRefusedTest = initialize(2, 1).then(tick)
   .expect(not(stampValid) and s.accepted == 0)
 run revokedLifetimeCacheIsNotAuthorityTest = initialize(-1, 1).then(revoke)
   .expect(stampValid and not(matchesPrimary) and s.accepted == 0)
   .then(refresh).expect(not(s.cache))
 run malformedStampCanRefreshTest = initialize(-1, 1).then(corrupt)
   .expect(not(stampValid)).then(refresh).then(admit).expect(s.accepted == 1)
 run futureGrantIsNotActiveTest = initialize(-1, 0)
   .expect(not(stampValid)).then(tick).then(admit).expect(s.accepted == 1)
}
