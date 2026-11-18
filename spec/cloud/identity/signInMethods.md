# Sign-in methods

A signed-in person reviews the methods that sign in to their account (email,
phone, Google), links a phone or Google, and removes a method. Sources:
develop's `/user/me/accounts*` routes in `packages/auth/src/server/api/routes/user.ts`
and the old `spec/auth/accountMethods.md` and `platformUsers.md` (`LinkProof`).
The device half, which shows the list and never repeats an ambiguous change,
is the os account settings.

Routes, all for a session (`requestAuth` class Session) except the removal:
`GET /api/v1/user/methods` answers `{reviewId, expiresAt, methods, stepUpAt,
mfaAt}`, where each method is `{id, kind, label, removable}` with `id` and
`kind` one of `email`, `phone`, `google`, and `stepUpAt` and `mfaAt` are the
calling session's (epoch milliseconds, or `null`).
`POST /api/v1/user/methods/phone/code/send` sends a link code
(`codeChallenges`, purpose `LinkPhoneCode`); `POST
/api/v1/user/methods/phone/code/verify` carries the `reviewId` with the code
and links the phone. `POST /api/v1/user/methods/google/challenge` starts a
Google attempt (`federatedSignIn`) and `POST
/api/v1/user/methods/google/link` carries the `reviewId` with Google's answer.
`DELETE /api/v1/user/methods/:methodId?reviewId=` removes a method; it is of
class StepUp, so a second factor more than 5 minutes old answers `428
fresh_session_required` before this machine. A link answers `{status:
"linked", method}`, an identity this account already holds `{status:
"already_linked", method}`, a removal `{status: "removed", method}`.

One machine instance is one account's review row. The account's identities
are `accounts`' to keep; they enter here as observations the shell reads in
the transaction that applies the step: who holds the subject being linked,
whether the account already holds a method of that kind, whether it holds the
method being removed and how many it holds. The shell draws the review id at
random.

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
type LinkProof = Unproven | ProvenThisAttempt
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
  isAttempt(via) implies (not(before.used) and after.used and after.reviewId == before.reviewId)
pure def stepOnlyAnAttemptChanges(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  not(isAttempt(via)) implies out == List()
pure def sometimesReviewOpen(m: Methods): bool = not(m.used)
```

### A phone or Google is linked only with a proof from this attempt, and never when another account holds it

The proof is the link code consumed for this user (`codeChallenges`,
`provesPhoneFor`) or the Google identity verified for this attempt
(`federatedSignIn`). The shell obtains it before it reads who holds the
subject, so a caller without it never learns whether the identity is taken.
An identity held by another account, or a second identity of a kind the
account already holds, answers `409 identity_in_use`; one this account holds
answers success and changes nothing. `LinkIdentity` is `accounts`' `link`,
applied in the same transaction.

```quint
pure val proofRefusal: Refusal = refuse(CredentialProofInvalid)
pure def linkAttempt(proof: LinkProof, holder: SubjectHolder, kindHeld: bool): Attempt =
  if (proof != ProvenThisAttempt) AttemptRefused({ refusal: proofRefusal })
  else if (holder == CallerHolds) AlreadyLinked
  else if (holder == OtherHolds or kindHeld) AttemptRefused({ refusal: A::inUseRefusal })
  else MethodLinked
pure def canLink(m: Methods, reviewId: str, now: Millis): bool = isFreshReview(m, reviewId, now)
pure def link(m: Methods, reviewId: str, now: Millis, proof: LinkProof, holder: SubjectHolder, kindHeld: bool): MethodsStep = {
  val decided = linkAttempt(proof, holder, kindHeld)
  { state: { ...m, used: true, outcome: decided }, out: if (decided == MethodLinked) List(LinkIdentity) else List() }
}
pure def lawUnprovenLinkRevealsNoHolder(holder: SubjectHolder, kindHeld: bool): bool =
  linkAttempt(Unproven, holder, kindHeld) == linkAttempt(Unproven, NobodyHolds, false)
pure def lawForeignIdentityNeverLinked(proof: LinkProof, kindHeld: bool): bool =
  linkAttempt(proof, OtherHolds, kindHeld) == AttemptRefused({ refusal: A::inUseRefusal }) or linkAttempt(proof, OtherHolds, kindHeld) == AttemptRefused({ refusal: proofRefusal })
pure def stepLinkOnlyWhenProvenAndFree(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  out.includes(LinkIdentity) iff (via == "link" and after.outcome == MethodLinked)
pure def sometimesLinked(m: Methods): bool = m.outcome == MethodLinked
pure def sometimesInUseRefused(m: Methods): bool = m.outcome == AttemptRefused({ refusal: A::inUseRefusal })
pure def sometimesAlreadyLinked(m: Methods): bool = m.outcome == AlreadyLinked
```

### A method is removed only while another remains, and its removal ends every other session

A method the account does not hold answers `404 not_found`; the last one
answers `409 last_method`. A removal applies `accounts`' `unlink` and
`sessions`' `revokeOthers` in one transaction, so the calling session stays
live and every other session of the person ends.

```quint
pure val absentRefusal: Refusal = refuse(NotFound)
pure def unlinkAttempt(held: bool, entries: int): Attempt =
  if (not(held)) AttemptRefused({ refusal: absentRefusal })
  else if (entries <= 1) AttemptRefused({ refusal: A::lastMethodRefusal })
  else MethodUnlinked
pure def canUnlink(m: Methods, reviewId: str, now: Millis): bool = isFreshReview(m, reviewId, now)
pure def unlink(m: Methods, reviewId: str, now: Millis, held: bool, entries: int): MethodsStep = {
  val decided = unlinkAttempt(held, entries)
  { state: { ...m, used: true, outcome: decided }, out: if (decided == MethodUnlinked) List(UnlinkIdentity, RevokeOtherSessions) else List() }
}
pure val entriesValues = Set(0, 1, 2, 3)
pure def isRemovable(entries: int): bool = entries >= 2
pure def lawLastMethodNeverRemoved(held: bool, entries: int): bool =
  unlinkAttempt(held, entries) == MethodUnlinked implies (held and isRemovable(entries))
pure def stepRemovalEndsOtherSessions(before: Methods, via: str, after: Methods, out: List[MethodsEffect]): bool =
  out.includes(UnlinkIdentity) iff (out.includes(RevokeOtherSessions) and via == "unlink" and after.outcome == MethodUnlinked)
pure def sometimesUnlinked(m: Methods): bool = m.outcome == MethodUnlinked
pure def sometimesLastMethodRefused(m: Methods): bool = m.outcome == AttemptRefused({ refusal: A::lastMethodRefusal })
```

### Every refusal this record builds is well formed

```quint
pure def lawEveryRefusalIsWellFormed(held: bool, entries: int): bool =
  wellFormed(reviewRefusal) and wellFormed(proofRefusal) and wellFormed(absentRefusal) and wellFormed(A::inUseRefusal) and wellFormed(A::lastMethodRefusal)
```
