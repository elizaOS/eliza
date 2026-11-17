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
owns a referral code. Generating ids and referral codes, naming the
organization after the user, and opening its funds with a balance of 0 (the
`billing/funds` row) are shell work. The deletion saga
(`identity/deletion`) imports this machine to fence and erase an account.

## Story: Get one account on first sign-in

> As a person signing in for the first time, I want one account and one
> organization made for me, and the same account found again on every later
> sign-in by any of my methods, so that I never end up split across two
> accounts or inside someone else's.

### A sign-in lands on the account holding its subject, else on the account holding its proven email, else on a new account

An identity is a sign-in method and its subject: the address for an email
code, the number for an SMS code, Google's subject id for Google. An email
code proves its address; Google proves an address only when it says the
address is verified. An unproven address is ignored and never stored. A
sign-in that lands on an account being deleted is refused `403
access_denied` with reason `account_inactive`; an erased account holds no
subject or address, so its person can start again.

```quint
import types.* from "../shared/types"
type AccountStatus = Unopened | Active | Deleting | Erased
type Identity = { method: SignInMethod, subject: str }
type Owner = Unowned | OwnedBy({ userId: str, status: AccountStatus })
type FirstSight = SignInAs({ account: str }) | AttachTo({ target: str }) | CreateAccount | AccountClosed
pure def emailProven(identity: Identity, verifiedEmail: bool): bool = identity.method == Email or verifiedEmail
pure def landOn(owner: Owner, admitted: FirstSight): FirstSight = match owner { | OwnedBy(o) => if (o.status == Active) admitted else AccountClosed | Unowned => CreateAccount }
pure def ownerId(owner: Owner): str = match owner { | OwnedBy(o) => o.userId | Unowned => "" }
pure def firstSight(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): FirstSight =
  if (subjectOwner != Unowned) landOn(subjectOwner, SignInAs({ account: ownerId(subjectOwner) }))
  else if (emailProven(identity, verifiedEmail)) landOn(emailOwner, AttachTo({ target: ownerId(emailOwner) }))
  else CreateAccount
pure def lawSubjectOutranksEmail(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  subjectOwner != Unowned implies firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == firstSight(identity, verifiedEmail, subjectOwner, Unowned)
pure def lawUnprovenEmailNeverAttaches(identity: Identity, subjectOwner: Owner, emailOwner: Owner): bool =
  identity.method != Email implies firstSight(identity, false, subjectOwner, emailOwner) == firstSight(identity, false, subjectOwner, Unowned)
pure val identityValues = Set({ method: Email, subject: "a@example.com" }, { method: Google, subject: "g1" }, { method: Phone, subject: "+15550100" })
pure val subjectOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
pure val emailOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
```

### A new account opens with its first sign-in method only when nobody holds the subject or the proven address

The new account is active, owns one organization and one referral code, and
was referred by nobody.

```quint
type Referral = NotReferred | ReferredBy({ code: str, referrerUserId: str })
type Account = { status: AccountStatus, userId: str, organizationId: str, identities: List[Identity], referralCode: str, referredBy: Referral, referralTotal: int }
pure val initial: Account = { status: Unopened, userId: "", organizationId: "", identities: List(), referralCode: "", referredBy: NotReferred, referralTotal: 0 }
pure def canOpen(a: Account, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  a.status == Unopened and firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == CreateAccount
pure def open(a: Account, userId: str, organizationId: str, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, referralCode: str): Account =
  { ...a, status: Active, userId: userId, organizationId: organizationId, identities: List(identity), referralCode: referralCode }
pure val userIdValues = Set("u1", "u2")
pure val organizationIdValues = Set("o1", "o2")
pure val referralCodeValues = Set("R1", "R2")
pure def alwaysUnopenedIsBlank(a: Account): bool = a.status == Unopened implies (a.identities == List() and a.referredBy == NotReferred and a.referralTotal == 0)
```

### A sign-in that lands on an account by its proven email adds its method to that account

```quint
pure def canAttach(a: Account, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  a.status == Active and firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == AttachTo({ target: a.userId }) and not(a.identities.includes(identity))
pure def attach(a: Account, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): Account = { ...a, identities: a.identities.append(identity) }
pure def sometimesTwoSignInMethods(a: Account): bool = a.status == Active and a.identities.length() >= 2
```

### An account holds each sign-in method once, and has at least one until it is erased

```quint
pure def alwaysIdentitiesAreDistinct(a: Account): bool = a.identities.every(i => a.identities.select(j => j == i).length() == 1)
pure def alwaysLiveAccountCanSignIn(a: Account): bool = (a.status == Active or a.status == Deleting) implies a.identities.length() >= 1
```

### An account keeps its user and its one organization for its whole life

```quint
pure def stepAccountKeepsItsUserAndOrganization(before: Account, after: Account): bool =
  before.status != Unopened implies (after.userId == before.userId and after.organizationId == before.organizationId)
```

## Story: Read my account

> As a signed-in person or one of my devices, I want to read who I am and
> which organization is mine, so that my device shows the right account and
> sends the right organization id to billing.

`GET /api/v1/user` answers `{id, email, phone, name, organization_id,
organization: {id, name}}`; email, phone and names come from the shell's
identity and organization rows. `GET /api/v1/referrals` answers `{code,
total_referrals, is_active}`, and `is_active` is always `true` because no
code is ever switched off. Request authentication admits only an active
account, so a fenced account is never read.

### My account reads as my user, my one organization and my referral code and count

```quint
type AccountView = { userId: str, organizationId: str, referralCode: str, totalReferrals: int }
pure def accountView(a: Account): AccountView = { userId: a.userId, organizationId: a.organizationId, referralCode: a.referralCode, totalReferrals: a.referralTotal }
```

## Story: Attribute a referral without paying for it

> As a person who was invited, I want to enter the code of the person who
> invited me once, so that they are credited with the referral, and nobody
> can mint money or credit themselves by doing so.

### A referral code is applied once, never one's own, and never an unknown one

An unknown code answers `404 not_found`. A second, different code or one's
own code answers `409 referral_already_applied`. Sending the code already
applied again answers success and changes nothing, so a retry after a lost
reply is safe.

```quint
type CodeOwner = UnknownCode | CodeOf({ ownerUserId: str })
type ReferralDecision = ApplyNew | SameCodeAgain | RefuseReferral({ refusal: RefusalCode })
pure def appliedCode(referral: Referral): str = match referral { | ReferredBy(r) => r.code | NotReferred => "" }
pure def referralDecision(a: Account, code: str, codeOwner: CodeOwner): ReferralDecision =
  if (a.referredBy != NotReferred) { if (appliedCode(a.referredBy) == code) SameCodeAgain else RefuseReferral({ refusal: ReferralAlreadyApplied }) }
  else if (codeOwner == UnknownCode) RefuseReferral({ refusal: NotFound })
  else if (codeOwnerId(codeOwner) == a.userId) RefuseReferral({ refusal: ReferralAlreadyApplied })
  else ApplyNew
type AccountEffect = CountReferral({ referrerUserId: str })
type ReferralApplied = { state: Account, out: List[AccountEffect] }
pure def codeOwnerId(codeOwner: CodeOwner): str = match codeOwner { | CodeOf(o) => o.ownerUserId | UnknownCode => "" }
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

### The referrer's count rises by one for each account that applies its code

The shell applies `CountReferral` to the referrer's row in the transaction
that records the referral. An account being deleted is still counted.

```quint
pure def canCountReferral(a: Account): bool = a.status == Active or a.status == Deleting
pure def countReferral(a: Account): Account = { ...a, referralTotal: a.referralTotal + 1 }
pure def alwaysReferralTotalIsNotNegative(a: Account): bool = a.referralTotal >= 0
pure def sometimesReferralCounted(a: Account): bool = a.referralTotal >= 1
```

### Applying or counting a referral changes nothing but the attribution

An account holds no money: funds are the `billing/funds` row, and the only
effect a referral emits is the count, so a referral never adds credit or
allowance to either account.

```quint
pure def stepReferralChangesOnlyAttribution(before: Account, via: str, after: Account): bool =
  (via == "applyReferral" implies after == { ...before, referredBy: after.referredBy })
  and (via == "countReferral" implies after == { ...before, referralTotal: before.referralTotal + 1 })
```

## Story: Close an account for deletion

> As the operator deleting an account the person asked support to delete, I
> want the account fenced first and its personal data erased last, so that
> nobody signs in to an account on its way out and nothing comes back.

### An active account is fenced as Deleting, and only a fenced account is erased

Erasing removes every sign-in method and the referral code; the user and
organization ids stay so that the ledger and invoices kept by organization
id still resolve. The order of the steps between is the deletion saga's.

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
