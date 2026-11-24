# Accounts

One account is one user and the one organization that user owns, kept as one
record. There are no members, invites or roles: the organization exists so
that `organization_id` stays on the wire and the ledger and invoices have a
key that outlives the person. Sources: develop's first sign-in account sync,
`lib/services/{users,organizations,referrals}.ts`, `api/v1/{user,referrals}`.

One machine instance is one account row. Rules across rows enter as
observations the shell reads in the same transaction, each backed by a unique
index: who holds a sign-in subject, who holds a proven email address, and who
owns a referral code. Ids, referral codes, names and the funds row (balance
0, `billing/funds`) are shell work. The account read, `GET /api/v1/user`,
leaves out an email, phone or name the account does not hold; it never sends
`null`.

## Story: Get one account on first sign-in

> As a person signing in for the first time, I want one account and one
> organization made for me, and the same account found again on every later
> sign-in by any of my methods, so that I never end up split across two
> accounts or inside someone else's.

### A sign-in lands on the account holding its subject, else on the one holding its proven address, else on a new account, and never on an account that is not active

An identity is a sign-in method and its subject: the address for an email
code, the number for an SMS code, Google's subject id for Google. An email
code proves its address; Google proves an address only when it says the
address is verified; an SMS code proves none. An unproven address is ignored
and never stored. The shell decides first sight in the transaction that
consumes the code challenge or Google attempt (`codeChallenges`,
`federatedSignIn`), and it runs `BeginSession`, `BeginSecondFactor` or a
device-key mint only when `admitsSignIn` holds; otherwise it mints nothing
and answers `closedRefusal` (`403 access_denied`, reason `account_inactive`).
On `AttachTo(t)` it applies `link` to account `t.target` in the same
transaction. `accountCreated` in the device answer is `firstSight(...) ==
CreateAccount`. An erased account holds no subject or address, so its person
can start again.

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
pure def admitsSignIn(landing: FirstSight): bool = landing != AccountClosed
pure val closedRefusal: Refusal = refuseFor(AccessDenied, AccountInactive)
pure def lawSubjectOutranksEmail(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, otherEmailOwner: Owner): bool =
  subjectOwner != Unowned implies firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == firstSight(identity, verifiedEmail, subjectOwner, otherEmailOwner)
pure def lawUnprovenEmailNeverAttaches(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  not(emailProven(identity, verifiedEmail)) implies firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == firstSight(identity, verifiedEmail, subjectOwner, Unowned)
pure def lawNeverLandsOnAClosedAccount(identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner): bool =
  val landing = firstSight(identity, verifiedEmail, subjectOwner, emailOwner)
  match landing {
    | SignInAs(s) => subjectOwner == OwnedBy({ userId: s.account, status: Active })
    | AttachTo(t) => subjectOwner == Unowned and emailOwner == OwnedBy({ userId: t.target, status: Active })
    | _ => true
  }
pure val identityValues = Set({ method: EmailSignIn, subject: "a@example.com" }, { method: GoogleSignIn, subject: "g1" }, { method: PhoneSignIn, subject: "+15550100" })
pure val verifiedEmailValues = Set(false, true)
pure val subjectOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
pure val emailOwnerValues = Set(Unowned, OwnedBy({ userId: "u1", status: Active }), OwnedBy({ userId: "u2", status: Deleting }))
pure val otherEmailOwnerValues = emailOwnerValues
```

### A new account opens with its first sign-in method and its own referral code only when nobody holds the subject or the proven address

The new account is active, owns one organization and one referral code, and
was referred by nobody. Its display name is the name Google gave, else the
local part of the proven address, else `User ***` and the last four digits of
the number; the organization is named the same.

```quint
type Referral = NotReferred | ReferredBy({ code: str, referrerUserId: str })
type Account = { status: AccountStatus, userId: str, organizationId: str, identities: List[Identity], referralCode: str, referredBy: Referral, referralTotal: int }
pure val initial: Account = { status: Unopened, userId: "", organizationId: "", identities: List(), referralCode: "", referredBy: NotReferred, referralTotal: 0 }
pure def canOpenAccount(a: Account, userId: str, organizationId: str, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, referralCode: str): bool =
  a.status == Unopened and userId != "" and organizationId != "" and referralCode != "" and firstSight(identity, verifiedEmail, subjectOwner, emailOwner) == CreateAccount
pure def openAccount(a: Account, userId: str, organizationId: str, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, referralCode: str): Account =
  { status: Active, userId: userId, organizationId: organizationId, identities: List(identity), referralCode: referralCode, referredBy: NotReferred, referralTotal: 0 }
pure val userIdValues = Set("u1", "u2")
pure val organizationIdValues = Set("o1", "o2")
pure val referralCodeValues = Set("R1", "R2")
pure def alwaysLiveAccountHasReferralCode(a: Account): bool = (a.status == Active or a.status == Deleting) implies a.referralCode != ""
```

### An account not yet opened was referred by nobody

A referral is applied only to an active account, so opening an account never
replaces a referral already made.

```quint
pure def alwaysUnopenedIsNotReferred(a: Account): bool = a.status == Unopened implies a.referredBy == NotReferred
```

### An identity held by nobody is linked, and an identity is removed only while another remains

This record is the one owner of an account's identities and of the unique
subject index. A proven address is kept on the identity row that proved it,
so unlinking that identity releases the address in the same delete.
`identity/signInMethods` checks the review, the step-up and the proof of the
new identity, then applies `link` or `unlink` here. An identity held by
another account answers `409 identity_in_use`; one this account already holds
answers success and changes nothing; removing the last one answers `409
last_method`.

```quint
pure def alreadyLinked(a: Account, subjectOwner: Owner): bool = a.userId != "" and ownerId(subjectOwner) == a.userId
pure def canLink(a: Account, identity: Identity, subjectOwner: Owner): bool =
  a.status == Active and subjectOwner == Unowned and not(a.identities.includes(identity))
pure def link(a: Account, identity: Identity, subjectOwner: Owner): Account = { ...a, identities: a.identities.append(identity) }
pure def unlink(a: Account, identity: Identity): Account = { ...a, identities: a.identities.select(i => i != identity) }
pure def canUnlink(a: Account, identity: Identity): bool = a.status == Active and a.identities.includes(identity) and unlink(a, identity).identities.length() >= 1
pure val inUseRefusal: Refusal = refuse(IdentityInUse)
pure val lastMethodRefusal: Refusal = refuse(LastMethod)
pure def sometimesTwoSignInMethods(a: Account): bool = a.status == Active and a.identities.length() >= 2
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

### An account moves only forward, from Unopened to Active to Deleting to Erased

`identity/deletion` owns the saga and its order. Fencing (Deleting) keeps the
account out of first sight; erasing keeps the user and organization ids, so
the ledger and invoices still resolve.

```quint
pure def statusRank(s: AccountStatus): int = if (s == Unopened) 0 else if (s == Active) 1 else if (s == Deleting) 2 else 3
pure def canBeginDeletion(a: Account): bool = a.status == Active
pure def beginDeletion(a: Account): Account = { ...a, status: Deleting }
pure def canErase(a: Account): bool = a.status == Deleting
pure def erase(a: Account): Account = { ...a, status: Erased, identities: List(), referralCode: "" }
pure def stepStatusNeverGoesBack(before: Account, after: Account): bool = statusRank(after.status) >= statusRank(before.status)
pure def sometimesErased(a: Account): bool = a.status == Erased
```

### An erased account holds no identity and no referral code

```quint
pure def alwaysErasedHoldsNoIdentityOrCode(a: Account): bool = a.status == Erased implies (a.identities == List() and a.referralCode == "")
```

## Story: Read my account

> As a signed-in person or one of my devices, I want to read who I am, which
> organization is mine and my referral code, so that my device shows the
> right account and sends the right organization id to billing.

Request authentication admits only an active account, so a fenced account is
never read. The referral read's `is_active` is always `true`.

### An opened account always names its user and its organization

```quint
type AccountView = { userId: str, organizationId: str, referralCode: str, totalReferrals: int }
pure def accountView(a: Account): AccountView =
  { userId: a.userId, organizationId: a.organizationId, referralCode: a.referralCode, totalReferrals: a.referralTotal }
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
  if (a.referredBy != NotReferred and appliedCode(a.referredBy) == code) SameCodeAgain
  else if (a.referredBy != NotReferred) RefuseReferral({ refusal: ReferralAlreadyApplied })
  else if (codeOwner == UnknownCode) RefuseReferral({ refusal: NotFound })
  else if (code == a.referralCode or codeOwnerId(codeOwner) == a.userId) RefuseReferral({ refusal: ReferralAlreadyApplied })
  else ApplyNew
type AccountEffect = CountReferral({ referrerUserId: str })
type ReferralApplied = { state: Account, out: List[AccountEffect] }
pure def canApplyReferral(a: Account, code: str, codeOwner: CodeOwner): bool = a.status == Active and code != "" and referralDecision(a, code, codeOwner) == ApplyNew
pure def applyReferral(a: Account, code: str, codeOwner: CodeOwner): ReferralApplied =
  { state: { ...a, referredBy: ReferredBy({ code: code, referrerUserId: codeOwnerId(codeOwner) }) }, out: List(CountReferral({ referrerUserId: codeOwnerId(codeOwner) })) }
pure val codeValues = Set("R1", "R2")
pure val codeOwnerValues = Set(UnknownCode, CodeOf({ ownerUserId: "u1" }), CodeOf({ ownerUserId: "u2" }))
pure def referrerOf(referral: Referral): str = match referral { | ReferredBy(r) => r.referrerUserId | NotReferred => "" }
pure def alwaysNeverReferredByItself(a: Account): bool = a.referredBy != NotReferred implies referrerOf(a.referredBy) != a.userId
pure def alwaysNeverReferredByOwnCode(a: Account): bool =
  a.referredBy != NotReferred implies (appliedCode(a.referredBy) != "" and appliedCode(a.referredBy) != a.referralCode)
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

### A referral emits only a count for its referrer and never touches funds

An account holds no money (funds are the `billing/funds` row), and
`AccountEffect` has the one variant `CountReferral`, so a referral never adds
credit or allowance to either account. The shell applies `CountReferral` to
the referrer's row in the transaction that records the referral; an account
being deleted is still counted.

```quint
pure def canCountReferral(a: Account): bool = a.status == Active or a.status == Deleting
pure def countReferral(a: Account): Account = { ...a, referralTotal: a.referralTotal + 1 }
pure def stepOnlyANewReferralCountsItsReferrer(before: Account, after: Account, out: List[AccountEffect]): bool =
  out.every(e => match e { | CountReferral(c) => before.referredBy == NotReferred and c.referrerUserId == referrerOf(after.referredBy) and c.referrerUserId != after.userId })
    and out.length() <= 1
pure def sometimesReferralCounted(a: Account): bool = a.referralTotal >= 1
```
