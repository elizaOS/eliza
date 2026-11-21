# Sign-in methods

A signed-in person reviews the methods that sign in to their account (email,
phone, Google), links a phone or Google, and removes a method. Sources:
develop's `/user/me/accounts*` routes in `packages/auth/src/server/api/routes/user.ts`
and the old `spec/auth/accountMethods.md` and `platformUsers.md` (`LinkProof`).
The device half, which shows the list and never repeats an ambiguous change,
is the os account settings.

Routes, all of `sessions`' route class SignedSession except the removal:
`GET /api/v1/user/methods` answers `{reviewId, expiresAt, methods, stepUpAt,
mfaAt}`, where each method is `{id, kind, label, removable}` with `kind` one
of `email`, `phone`, `google`, `removable` is `isRemovable` of the others the
account holds, and `stepUpAt` and `mfaAt` are the calling session's (epoch
milliseconds, or `null`).
`POST /api/v1/user/methods/phone/code/send` sends a link code
(`codeChallenges`, purpose `LinkPhoneCode`); `POST
/api/v1/user/methods/phone/code/verify` carries the `reviewId` with the code
and links the phone. `POST /api/v1/user/methods/google/challenge` opens a
native Google link challenge (`federatedSignIn`, purpose `NativeLink`) and
`POST /api/v1/user/methods/google/link` carries the `reviewId` with Google's
ID token. `DELETE /api/v1/user/methods/:methodId?reviewId=` removes a method.
A link answers `{status: "linked", method}`, an identity this account
already holds `{status: "already_linked", method}`, a removal `{status:
"removed", method}`.

One machine instance is one account's review row. The account's identities
are `accounts`' to keep; they enter here as observations the shell reads in
the transaction that applies the step: who holds the subject being linked,
whether the account already holds a method of that kind, whether it holds the
method being removed and how many others it holds. The shell draws the
review id at random.

## Story: Review, link and remove my sign-in methods

> As a person, I want to see how I can sign in and change it safely, so that
> I never lock myself out, never take over someone else's identity, and never
> act on a list that changed under me.

### A mutation needs the id of a review less than a minute old, and one review admits one attempt

Reading the list opens a new review and closes the one before. A link or a
removal names its review; an unknown, used or older review answers `409
stale_revision` and changes nothing. Any attempt on a fresh review uses it up,
whatever its answer, so an attempt whose answer was lost is never repeated on
the same review: the device reads the list again first.

```quint
import types.* from "../shared/types"
import accounts as A from "./accounts"
import codeChallenges as C from "./codeChallenges"
import federatedSignIn as G from "./federatedSignIn"
import sessions as S from "./sessions"
type LinkProof = Unproven({ refusal: Refusal }) | ProvenThisAttempt
type SubjectHolder = NobodyHolds | CallerHolds | OtherHolds
type MethodsEffect = LinkIdentity | UnlinkIdentity | RevokeOtherSessions
type Attempt = NoAttempt | MethodLinked | AlreadyLinked | MethodUnlinked | AttemptRefused({ refusal: Refusal })
type Methods = { reviewId: str, reviewAt: Millis, used: bool, outcome: Attempt }
type MethodsStep = { state: Methods, out: List[MethodsEffect] }
pure val reviewLifetime: Millis = 60 * millisPerSecond
pure val reviewRefusal: Refusal = refuse(StaleRevision)
pure val initial: Methods = { reviewId: "", reviewAt: 0, used: true, outcome: NoAttempt }
pure def reviewExpiresAt(m: Methods): Millis = m.reviewAt + reviewLifetime
pure def isFreshReview(m: Methods, reviewId: str, now: Millis): bool =
  reviewId != "" and reviewId == m.reviewId and not(m.used) and now >= m.reviewAt and now < reviewExpiresAt(m)
pure def canReview(m: Methods, reviewId: str, now: Millis): bool = reviewId != "" and reviewId != m.reviewId and now >= 0
pure def review(m: Methods, reviewId: str, now: Millis): Methods = { reviewId: reviewId, reviewAt: now, used: false, outcome: NoAttempt }
pure val reviewIdValues = Set("r1", "r2")
pure val nowValues = Set(0, 30000, 60000, 120000)
pure def isAttempt(via: str): bool = via == "link" or via == "unlink"
pure def alwaysAnOpenReviewHasAnId(m: Methods): bool = not(m.used) implies (m.reviewId != "" and m.outcome == NoAttempt)
pure def stepAnAttemptUsesAFreshReview(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  (isAttempt(via) implies (not(before.used) and after.used and after.reviewId == before.reviewId))
  and (not(isAttempt(via)) implies out == List())
pure def sometimesReviewOpen(m: Methods): bool = not(m.used)
```

### A phone or Google is linked only with a proof from this attempt for the caller, and never when another account holds it

The proof is the link code consumed for the caller (`codeChallenges`'
`verify`, then `phoneProof`) or the native Google link challenge spent for
the caller (`federatedSignIn`'s `presentIdToken`, then `googleProof`). The
shell obtains it before it reads who holds the subject, so a caller without
it never learns whether the identity is taken: a refused proof enters as
`Unproven` with the refusal of the spec that refused it (a wrong, expired or
locked code; a Google token that does not verify), uses the review up and is
answered with that refusal. An identity held by another account, or a second
identity of a kind the account already holds, answers `409 identity_in_use`;
one this account holds answers success and changes nothing. `LinkIdentity`
is `accounts`' `link`, applied in the same transaction.

```quint
pure def phoneProof(c: C::Challenge, userId: str): LinkProof =
  if (C::provesPhoneFor(c, userId)) ProvenThisAttempt else Unproven({ refusal: C::verifyRefusal(c) })
pure def googleProof(attempt: G::GoogleAttempt, userId: str, token: G::NativeProof): LinkProof =
  if (G::provesGoogleFor(attempt, userId)) ProvenThisAttempt
  else Unproven({ refusal: G::nativeRefusal(G::nativeVerdict(attempt.native, attempt.now, token)) })
pure def linkProven(holder: SubjectHolder, kindHeld: bool): Attempt =
  if (holder == CallerHolds) AlreadyLinked
  else if (holder == OtherHolds or kindHeld) AttemptRefused({ refusal: A::inUseRefusal })
  else MethodLinked
pure def linkAttempt(proof: LinkProof, holder: SubjectHolder, kindHeld: bool): Attempt =
  match proof {
    | Unproven(p) => AttemptRefused({ refusal: p.refusal })
    | ProvenThisAttempt => linkProven(holder, kindHeld)
  }
pure def canLink(m: Methods, reviewId: str, now: Millis): bool = isFreshReview(m, reviewId, now)
pure def link(m: Methods, reviewId: str, now: Millis, proof: LinkProof, holder: SubjectHolder, kindHeld: bool): MethodsStep = {
  val decided = linkAttempt(proof, holder, kindHeld)
  { state: { ...m, used: true, outcome: decided }, out: if (decided == MethodLinked) List(LinkIdentity) else List() }
}
pure val openCode: C::Challenge = C::send(C::initial, PhoneSignIn, C::LinkPhoneCode({ userId: "u1" }), "app.one", true).state
pure val cValues = Set(openCode).union(Set({ ...openCode, phase: C::Consumed({ yields: C::PhoneProofYield }) })).union(Set({ ...openCode, phase: C::Locked, failures: 5 }))
pure val openNative: G::GoogleAttempt = { ...G::initial, native: G::ChallengeOpen({ purpose: G::NativeLink({ userId: "u1" }), openUntil: 300000 }) }
pure val attemptValues = Set(openNative).union(Set({ ...openNative, native: G::ChallengeUsed({ purpose: G::NativeLink({ userId: "u1" }), usedAs: G::GoogleProofYield }) }))
pure val tokenValues = G::proofValues
pure val userIdValues = Set("u1", "u2")
pure val otherIdValues = userIdValues
pure val proofValues = Set(ProvenThisAttempt).union(Set(phoneProof(openCode, "u1"))).union(Set(Unproven({ refusal: C::verifyRefusal({ ...openCode, phase: C::Locked, failures: 5 }) })))
pure def lawAProofServesOnlyItsOwnCaller(c: C::Challenge, attempt: G::GoogleAttempt, token: G::NativeProof, userId: str, otherId: str): bool =
  userId != otherId implies not(phoneProof(c, userId) == ProvenThisAttempt and phoneProof(c, otherId) == ProvenThisAttempt)
    and not(googleProof(attempt, userId, token) == ProvenThisAttempt and googleProof(attempt, otherId, token) == ProvenThisAttempt)
pure def lawUnprovenLinkRevealsNoHolder(proof: LinkProof, holder: SubjectHolder, kindHeld: bool): bool =
  proof != ProvenThisAttempt implies linkAttempt(proof, holder, kindHeld) == linkAttempt(proof, NobodyHolds, false)
pure def lawForeignIdentityNeverLinked(proof: LinkProof, kindHeld: bool): bool = linkAttempt(proof, OtherHolds, kindHeld) != MethodLinked
pure def stepLinkOnlyWhenProvenAndFree(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  out.includes(LinkIdentity) iff (via == "link" and after.outcome == MethodLinked)
pure def sometimesLinked(m: Methods): bool = m.outcome == MethodLinked
pure def sometimesInUseRefused(m: Methods): bool = m.outcome == AttemptRefused({ refusal: A::inUseRefusal })
pure def sometimesAlreadyLinked(m: Methods): bool = m.outcome == AlreadyLinked
pure def sometimesUnprovenRefused(m: Methods): bool = m.outcome == AttemptRefused({ refusal: refuseFor(AccessDenied, ChallengeLocked) })
```

### A method is removed only after a step-up within five minutes and while another remains, and its removal ends every other session

The removal is of `sessions`' route class StepUp: a session whose last second
factor is more than 5 minutes old answers `428 fresh_session_required` before
this machine and leaves the review open, so the device can step up and send
the removal again. A method the account does not hold answers `404
not_found`; the last one answers `409 last_method`. A removal applies
`accounts`' `unlink` and `sessions`' `revokeOthers` on the calling family in
one transaction, so the calling session stays live and every other session of
the person ends.

```quint
pure val removalRoute: S::RouteClass = S::StepUp
pure val absentRefusal: Refusal = refuse(NotFound)
pure def isRemovable(others: int): bool = others >= 1
pure def unlinkAttempt(held: bool, others: int): Attempt =
  if (not(held)) AttemptRefused({ refusal: absentRefusal })
  else if (not(isRemovable(others))) AttemptRefused({ refusal: A::lastMethodRefusal })
  else MethodUnlinked
pure def canUnlink(m: Methods, reviewId: str, now: Millis): bool = isFreshReview(m, reviewId, now)
pure def unlink(m: Methods, reviewId: str, now: Millis, held: bool, others: int): MethodsStep = {
  val decided = unlinkAttempt(held, others)
  { state: { ...m, used: true, outcome: decided }, out: if (decided == MethodUnlinked) List(UnlinkIdentity, RevokeOtherSessions) else List() }
}
pure val othersValues = Set(0, 1, 2)
pure def lawRemovalNeedsARecentSecondFactor(view: S::CredentialView, now: Millis): bool =
  S::admitRequest(view, removalRoute, now) == S::CredentialAccepted implies (view.kind == S::RequestSession and view.mfaAt > 0 and view.mfaAt >= now - S::stepUpWindow)
pure def lawLastMethodNeverRemoved(held: bool, others: int): bool =
  unlinkAttempt(held, others) == MethodUnlinked implies (held and others >= 1)
pure def stepRemovalEndsOtherSessions(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  out.includes(UnlinkIdentity) iff (out.includes(RevokeOtherSessions) and via == "unlink" and after.outcome == MethodUnlinked)
pure def sometimesUnlinked(m: Methods): bool = m.outcome == MethodUnlinked
pure def sometimesLastMethodRefused(m: Methods): bool = m.outcome == AttemptRefused({ refusal: A::lastMethodRefusal })
```

### Every refusal this record answers is well formed and not retryable

A refused attempt needs the person to act (read the list again, pick
another method, ask for a new code), so a client never retries one as it
stands.

```quint
pure def attemptFinal(answer: Attempt): bool = match answer { | AttemptRefused(r) => wellFormed(r.refusal) and not(retryableOf(r.refusal)) | _ => true }
pure def lawEveryRefusalIsFinal(c: C::Challenge, attempt: G::GoogleAttempt, token: G::NativeProof, userId: str, holder: SubjectHolder, kindHeld: bool, held: bool, others: int): bool =
  wellFormed(reviewRefusal) and not(retryableOf(reviewRefusal))
    and attemptFinal(linkAttempt(phoneProof(c, userId), holder, kindHeld))
    and attemptFinal(linkAttempt(googleProof(attempt, userId, token), holder, kindHeld))
    and attemptFinal(unlinkAttempt(held, others))
```
