# Accounts

One account is one user and the one organization that user owns, kept as one
record. There are no members, invites or roles: the organization exists so
that `organization_id` stays on the wire and the ledger and invoices have a
key that outlives the person. Sources are develop
`packages/cloud/shared/src/lib/steward-sync.ts` (first sign-in),
`lib/services/{users,organizations,referrals}.ts` and the routes
`api/v1/user` and `api/v1/referrals`.

One machine instance is one account row. Rules across rows enter as
observations the shell reads in the same transaction, each backed by a unique
index: who holds a sign-in subject, who holds a proven email address, and who
owns a referral code. Ids, referral codes, the organization's name and its
funds row (balance 0, `billing/funds`) are shell work.

## Story: Get one account on first sign-in

> As a person signing in for the first time, I want one account and one
> organization made for me, and the same account found again on every later
> sign-in by any of my methods, so that I never end up split across two
> accounts or inside someone else's.

### A sign-in lands on the account holding its subject, else on the account holding its proven email, else on a new account

An identity is a sign-in method and its subject: the address for an email
code, the number for an SMS code, Google's subject id for Google. An email
code proves its address; Google proves an address only when it says the
address is verified; an SMS code proves none. An unproven address is ignored
and never stored. The shell decides first sight in the transaction that
consumes the code challenge or Google attempt, before any session or device
key is minted; `accountCreated` in the device answer is `firstSight(...) ==
CreateAccount`. On `AccountClosed` the transaction mints nothing and answers
`403 access_denied` with reason `account_inactive`. An erased account holds
no subject or address, so its person can start again.

```quint
import types.* from "../shared/types"
type AccountStatus = Unopened | Active | Deleting | Erased
type Identity = { method: SignInMethod, subject: str }
type Owner = Unowned | OwnedBy({ userId: str, status: AccountStatus })
type FirstSight = SignInAs({ account: str }) | AttachTo({ target: str }) | CreateAccount | AccountClosed
pure def emailProven(identity: Identity, verifiedEmail: bool): bool =
  identity.method == EmailSignIn or (identity.method == GoogleSignIn and verifiedEmail)
pure def landOn(owner: Owner, admitted: FirstSight): FirstSight = match owner { | OwnedBy(o) => if (o.status == Active) admitted else AccountClosed | Unowned => CreateAccount }
pure def ownerId(owner: Owner): str = match owner { | OwnedBy(o) => o.userId | Unowned => "" }
pure def firstSight(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): FirstSight =
  if (subjectOwner != Unowned) landOn(subjectOwner, SignInAs({ account: ownerId(subjectOwner) }))
  else if (emailProven(identity, verifiedEmail)) landOn(emailOwner, AttachTo({ target: ownerId(emailOwner) }))
  else CreateAccount
pure val closedRefusal: Refusal = refuseFor(AccessDenied, AccountInactive)
pure def lawNeverLandsOnAnotherAccount(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  val landing = firstSight(identity, verifiedEmail, subjectOwner, emailOwner)
  match landing {
    | SignInAs(s) => s.account == ownerId(subjectOwner)
    | AttachTo(t) => subjectOwner == Unowned and identity.method != PhoneSignIn and t.target == ownerId(emailOwner)
    | _ => true
  }
pure val identityValues = Set({ method: EmailSignIn, subject: "a@example.com" }, { method: GoogleSignIn, subject: "g1" }, { method: PhoneSignIn, subject: "+15550100" })
pure val verifiedEmailValues = Set(false, true)
pure val subjectOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
pure val emailOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
```

### A new account opens with its first sign-in method only when nobody holds the subject or the proven address

The new account is active, has a user, owns one organization and one
referral code, and was referred by nobody, because an unopened row is blank.
An empty referral code means no code and is stored as NULL.

```quint
type Referral = NotReferred | ReferredBy({ code: str, referrerUserId: str })
type Account = { status: AccountStatus, userId: str, organizationId: str, identities: List[Identity], referralCode: str, referredBy: Referral, referralTotal: int }
pure val initial: Account = { status: Unopened, userId: "", organizationId: "", identities: List(), referralCode: "", referredBy: NotReferred, referralTotal: 0 }
pure def canOpen(a: Account, userId: str, organizationId: str, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  a.status == Unopened and userId != "" and organizationId != "" and firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == CreateAccount
pure def open(a: Account, userId: str, organizationId: str, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, referralCode: str): Account =
  { ...a, status: Active, userId: userId, organizationId: organizationId, identities: List(identity), referralCode: referralCode }
pure val userIdValues = Set("u1", "u2")
pure val organizationIdValues = Set("o1", "o2")
pure val referralCodeValues = Set("R1", "R2")
pure def alwaysUnopenedIsBlank(a: Account): bool = a.status == Unopened implies (a.identities == List() and a.referredBy == NotReferred and a.referralTotal == 0)
```

### A sign-in that lands on an account by its proven email adds its identity to that account

```quint
pure def canAttach(a: Account, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  a.status == Active and firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == AttachTo({ target: a.userId }) and not(a.identities.includes(identity))
pure def attach(a: Account, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): Account = { ...a, identities: a.identities.append(identity) }
pure def sometimesTwoSignInMethods(a: Account): bool = a.status == Active and a.identities.length() >= 2
```

### An identity held by nobody is linked, and an identity is removed only while another remains

This record is the one owner of an account's identities and of the unique
subject index. `identity/signInMethods` checks the review, the step-up and
the proof of the new identity, then applies `link` or `unlink` here. An
identity held by any account answers `409 identity_in_use`; removing the last
one answers `409 last_method`.

```quint
pure def canLink(a: Account, identity: Identity, subjectOwner: Owner): bool =
  a.status == Active and subjectOwner == Unowned and not(a.identities.includes(identity))
pure def link(a: Account, identity: Identity, subjectOwner: Owner): Account = { ...a, identities: a.identities.append(identity) }
pure def canUnlink(a: Account, identity: Identity): bool = a.status == Active and a.identities.includes(identity) and a.identities.length() >= 2
pure def unlink(a: Account, identity: Identity): Account = { ...a, identities: a.identities.select(i => i != identity) }
pure val inUseRefusal: Refusal = refuse(IdentityInUse)
pure val lastMethodRefusal: Refusal = refuse(LastMethod)
```

### An account holds each identity once, and at least one until it is erased

```quint
pure def alwaysIdentitiesAreDistinct(a: Account): bool = a.identities.every(i => a.identities.select(j => j == i).length() == 1)
pure def alwaysLiveAccountCanSignIn(a: Account): bool = (a.status == Active or a.status == Deleting) implies a.identities.length() >= 1
```

### An account keeps its user and its one organization for its whole life

```quint
pure def stepAccountKeepsItsUserAndOrganization(before: Account, after: Account): bool =
  before.status != Unopened implies (after.userId == before.userId and after.organizationId == before.organizationId)
```

### A closing account is fenced as Deleting, and only a fenced account is erased

`identity/deletion` owns the saga and its order. Fencing keeps the account
out of first sight; erasing removes every identity and the referral code and
keeps the user and organization ids, so the ledger and invoices still
resolve.

```quint
pure def statusRank(s: AccountStatus): int = if (s == Unopened) 0 else if (s == Active) 1 else if (s == Deleting) 2 else 3
pure def canBeginDeletion(a: Account): bool = a.status == Active
pure def beginDeletion(a: Account): Account = { ...a, status: Deleting }
pure def canErase(a: Account): bool = a.status == Deleting
pure def erase(a: Account): Account = { ...a, status: Erased, identities: List(), referralCode: "" }
pure def alwaysErasedHoldsNoSignInMethod(a: Account): bool = a.status == Erased implies (a.identities == List() and a.referralCode == "")
pure def stepStatusNeverGoesBack(before: Account, after: Account): bool = statusRank(after.status) >= statusRank(before.status)
pure def sometimesErased(a: Account): bool = a.status == Erased and a.organizationId != ""
```

## Story: Read my account

> As a signed-in person or one of my devices, I want to read who I am and
> which organization is mine, so that my device shows the right account and
> sends the right organization id to billing.

`GET /api/v1/user` answers `{success: true, data: {id, email, phone, name,
organization_id, organization: {id, name}}}`; email, phone and names come
from the shell's identity and organization rows. `GET /api/v1/referrals`
answers the bare object `{code, total_referrals, is_active}`, and `is_active`
is always `true` because no code is ever switched off. Request authentication
admits only an active account, so a fenced account is never read.

### An opened account always names its user and its organization

```quint
pure def alwaysOpenedAccountHasItsOrganization(a: Account): bool = a.status != Unopened implies (a.userId != "" and a.organizationId != "")
```

## Story: Attribute a referral without paying for it

> As a person who was invited, I want to enter the code of the person who
> invited me once, so that they are credited with the referral, and nobody
> can mint money or credit themselves by doing so.

### A referral code is applied once, never one's own, and never an unknown one

The shell trims and uppercases the code before the owner lookup and before
`referralDecision`, and stores that form. An unknown code answers `404
not_found`. A second, different code or one's own code answers `409
referral_already_applied`. A new code and the code already applied both
answer `{success: true}`; the second changes nothing, so a retry after a lost
reply is safe.

```quint
type CodeOwner = UnknownCode | CodeOf({ ownerUserId: str })
type ReferralDecision = ApplyNew | SameCodeAgain | RefuseReferral({ refusal: RefusalCode })
pure def appliedCode(referral: Referral): str = match referral { | ReferredBy(r) => r.code | NotReferred => "" }
pure def codeOwnerId(codeOwner: CodeOwner): str = match codeOwner { | CodeOf(o) => o.ownerUserId | UnknownCode => "" }
pure def referralDecision(a: Account, code: str, codeOwner: CodeOwner): ReferralDecision =
  if (a.referredBy != NotReferred) { if (appliedCode(a.referredBy) == code) SameCodeAgain else RefuseReferral({ refusal: ReferralAlreadyApplied }) }
  else if (codeOwner == UnknownCode) RefuseReferral({ refusal: NotFound })
  else if (codeOwnerId(codeOwner) == a.userId) RefuseReferral({ refusal: ReferralAlreadyApplied })
  else ApplyNew
type AccountEffect = CountReferral({ referrerUserId: str })
type ReferralApplied = { state: Account, out: List[AccountEffect] }
pure def canApplyReferral(a: Account, code: str, codeOwner: CodeOwner): bool = a.status == Active and referralDecision(a, code, codeOwner) == ApplyNew
pure def applyReferral(a: Account, code: str, codeOwner: CodeOwner): ReferralApplied =
  { state: { ...a, referredBy: ReferredBy({ code: code, referrerUserId: codeOwnerId(codeOwner) }) }, out: List(CountReferral({ referrerUserId: codeOwnerId(codeOwner) })) }
pure val codeValues = Set("R1", "R2")
pure val codeOwnerValues = Set(UnknownCode, CodeOf({ ownerUserId: "u1" }), CodeOf({ ownerUserId: "u2" }))
pure def referrerOf(referral: Referral): str = match referral { | ReferredBy(r) => r.referrerUserId | NotReferred => "" }
pure def alwaysNeverReferredByItself(a: Account): bool = a.referredBy != NotReferred implies referrerOf(a.referredBy) != a.userId
pure def stepReferralIsFinal(before: Account, after: Account): bool = before.referredBy != NotReferred implies after.referredBy == before.referredBy
pure def sometimesReferred(a: Account): bool = a.referredBy != NotReferred
```

### Every refusal this record builds is well formed

```quint
pure def lawEveryRefusalIsWellFormed(a: Account, code: str, codeOwner: CodeOwner): bool =
  val decision = referralDecision(a, code, codeOwner)
  val referralFits = match decision { | RefuseReferral(r) => wellFormed(refuse(r.refusal)) | _ => true }
  wellFormed(closedRefusal) and wellFormed(inUseRefusal) and wellFormed(lastMethodRefusal) and referralFits
```

### Recording a referral emits one count for its referrer and nothing else

An account holds no money: funds are the `billing/funds` row, and the count
is the only effect a referral emits, so a referral never adds credit or
allowance to either account. The shell applies `CountReferral` to the
referrer's row in the transaction that records the referral; an account
being deleted is still counted.

```quint
pure def canCountReferral(a: Account): bool = a.status == Active or a.status == Deleting
pure def countReferral(a: Account): Account = { ...a, referralTotal: a.referralTotal + 1 }
pure def stepReferralCountedOnceForItsReferrer(before: Account, via: str, after: Account, out: List[AccountEffect]): bool =
  out == List() or (via == "applyReferral" and before.referredBy == NotReferred and after.referredBy != NotReferred
    and out == List(CountReferral({ referrerUserId: referrerOf(after.referredBy) })))
pure def alwaysReferralTotalIsNotNegative(a: Account): bool = a.referralTotal >= 0
pure def sometimesReferralCounted(a: Account): bool = a.referralTotal >= 1
```
