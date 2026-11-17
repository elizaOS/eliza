# Operator commands

The operator runs a deployment through the `elizaos-cloud` command line only;
there is no HTTP admin route. The commands are `migrate`, `client
register|update|disable`, `grants mint|disable`, `prices set|check`,
`credits add` and `account delete|devices|revoke-devices`; `serve` belongs to
`deployment`. Sources are develop `packages/cloud/scripts/admin/`
(`preflight-database-identity.ts`, `mint-subscription-grant-codes.ts`,
`revoke-subscription-grants.ts`) and the products' registration and seeding
scripts, which this replaces.

This library decides whether a command may run. The spec that owns each
record checks the command's content, and a command answers what it changed by
count or by the operator's own identifiers.

## Story: Operate the deployment without reading secrets

> As the operator of a deployment, I want to register clients, mint codes,
> set prices, fund pilot accounts and act on a person's request to delete
> their account or sign out a lost device from one command line, so that I
> never need to open a database row, a token or a provider secret to do it.

### The operator has twelve commands, and only checking prices and listing devices leave the database unchanged

`prices set` writes the operator's model price table (`services/models`).
`prices check` compares the payment provider's plan prices with
`billing/plans`, as `deployment` does before it serves, and the model price
table with the profile's models. `account devices` reads one user's live keys.

```quint
import types.* from "./shared/types"
import deployment.* from "./deployment"
import accounts as A from "./identity/accounts"
type OperatorCommand =
  Migrate | RegisterClient | UpdateClient | DisableClient | MintGrantCodes | DisableGrantCodes
  | SetPrices | CheckPrices | AddCredits | RequestDeletion | ListDevices | RevokeDevices
pure def writes(command: OperatorCommand): bool = not(Set(CheckPrices, ListDevices).contains(command))
pure def namesAnAccount(command: OperatorCommand): bool = Set(AddCredits, RequestDeletion, ListDevices, RevokeDevices).contains(command)
```

### A command is refused for the first check it fails, the database check before every other

An account not yet opened is not found, like a missing one.

```quint
type AccountSeen = NoAccount | Seen({ status: A::AccountStatus })
type OperatorVerdict = Proceed | ExistingDeletion | Refused({ code: RefusalCode, reason: RefusalReason, wait: WaitTime })
pure def statusSeen(account: AccountSeen): A::AccountStatus = match account { | Seen(a) => a.status | NoAccount => A::Unopened }
pure def runs(verdict: OperatorVerdict): bool = match verdict { | Refused(r) => false | Proceed => true | ExistingDeletion => true }
pure def refusedWith(code: RefusalCode, reason: RefusalReason): OperatorVerdict = Refused({ code: code, reason: reason, wait: NoWait })
pure def decide(identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, count: int): OperatorVerdict =
  if (identity == UnreadableDatabase) refusedWith(ServiceUnavailable, NoReason)
  else if (identity == OtherDatabase) refusedWith(PreconditionFailed, NoReason)
  else if (namesAnAccount(command) and statusSeen(account) == A::Unopened) refusedWith(NotFound, NoReason)
  else if (command == AddCredits and statusSeen(account) != A::Active) refusedWith(AccessDenied, AccountInactive)
  else if (command == RequestDeletion and not(confirmed)) refusedWith(InvalidRequest, NoReason)
  else if (command == RequestDeletion and statusSeen(account) != A::Active) ExistingDeletion
  else if (command == MintGrantCodes and not(mintBatchFits(count))) refusedWith(InvalidRequest, NoReason)
  else Proceed
pure val accountValues: Set[AccountSeen] = Set(NoAccount, Seen({ status: A::Unopened }), Seen({ status: A::Active }), Seen({ status: A::Deleting }), Seen({ status: A::Erased }))
pure def lawDatabaseCheckComesFirst(identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, count: int): bool =
  identity != MatchingDatabase implies decide(identity, command, account, confirmed, count) == decide(identity, Migrate, NoAccount, false, 0)
pure def lawEveryOperatorRefusalIsWellFormed(identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, count: int): bool = {
  val verdict = decide(identity, command, account, confirmed, count)
  match verdict { | Refused(r) => wellFormed({ code: r.code, reason: r.reason, wait: r.wait }) | Proceed => true | ExistingDeletion => true }
}
```

### A command runs only on the database whose identity the profile names for its environment

In the session that runs the command, the shell reads the connected
database's cluster receipt and authority (role and database) receipt and
compares the one SHA-256 digest of both with the environment's expected
digest in the profile. A file-backed PGlite store carries this identity like
any store, so a local `serve` and the command line accept the same store. An
identity that cannot be read is refused as unavailable; another one as a
failed precondition.

```quint
type StoreIdentity = MatchingDatabase | OtherDatabase | UnreadableDatabase
type IdentityRead = UnreadableIdentity | ReadDigest({ digest: str })
pure def identityOf(p: Profile, environment: Environment, read: IdentityRead): StoreIdentity = match read {
  | ReadDigest(r) => if (r.digest == rowOf(p, environment).databaseDigest) MatchingDatabase else OtherDatabase
  | UnreadableIdentity => UnreadableDatabase
}
pure val readValues: Set[IdentityRead] = Set(UnreadableIdentity, ReadDigest({ digest: "d1" }), ReadDigest({ digest: "d2" }), ReadDigest({ digest: "d3" }))
pure def lawCommandsRunOnlyOnTheNamedDatabase(p: Profile, environment: Environment, read: IdentityRead, command: OperatorCommand, account: AccountSeen, confirmed: bool, count: int): bool =
  runs(decide(identityOf(p, environment, read), command, account, confirmed, count)) implies read == ReadDigest({ digest: rowOf(p, environment).databaseDigest })
pure def lawACommandNeverReachesTheOtherEnvironmentsDatabase(p: Profile, environment: Environment, read: IdentityRead, command: OperatorCommand, account: AccountSeen, confirmed: bool, count: int): bool =
  (profileAccepted(p) and runs(decide(identityOf(p, environment, read), command, account, confirmed, count)))
    implies read != ReadDigest({ digest: rowOf(p, otherEnvironment(environment)).databaseDigest })
```

### Credits go only to an active account

Accounts are funded by the operator or by plan allowance; nothing in the
cloud sells credits. The amount (at least 1 µUSD) and the request key that
makes a repeated command change nothing belong to `billing/funds`.

```quint
pure def lawCreditsReachOnlyAnActiveAccount(identity: StoreIdentity, account: AccountSeen, confirmed: bool, count: int): bool =
  runs(decide(identity, AddCredits, account, confirmed, count)) implies account == Seen({ status: A::Active })
```

### An account deletion starts only for an active account, after the operator confirmed the request with its owner

The command requires `--confirmed-with-owner`. On an active account it starts
the saga of `identity/deletion`; on an account already deleting or erased it
answers the deletion that exists and starts nothing.

```quint
pure def lawOnlyConfirmedDeletionsStart(identity: StoreIdentity, account: AccountSeen, confirmed: bool, count: int): bool = {
  val verdict = decide(identity, RequestDeletion, account, confirmed, count)
  (verdict == Proceed implies (confirmed and account == Seen({ status: A::Active })))
    and (verdict == ExistingDeletion implies (confirmed and Set(A::Deleting, A::Erased).contains(statusSeen(account))))
}
```

### A mint makes from 1 to 10,000 codes in one transaction, all or none

`grants mint` prints each new code on its own line of standard output after
the mint transaction commits, and never if it fails, so every printed code
exists. The code's format, its keyed digest and its one declassification
belong to `billing/grantCodes`. No command shows a code again, a session
token, a device key, a refresh token or a provider secret.

```quint
pure val maxMintBatch: int = 10000
pure def mintBatchFits(count: int): bool = count >= 1 and count <= maxMintBatch
pure val countValues = Set(0, 1, maxMintBatch, maxMintBatch + 1)
```

### The operator sees a device only as its name and dates

`account devices` lists the user's live device keys. `account revoke-devices`
moves the user's device epoch (`nativeClients/deviceKeys` `revokeAll`) and
answers how many keys it ended; it leaves the user's sessions alone, which
only account deletion ends with the keys. Neither shows a credential id, a
key or its digest.

```quint
type DeviceRow = { deviceName: str, createdAt: Millis, expiresAt: Millis }
```
