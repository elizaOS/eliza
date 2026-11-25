# Operator commands

The operator runs a deployment through the `elizaos-cloud` command line only;
there is no HTTP admin route. The commands are `migrate`, `client
register|update|apply|disable`, `grants mint|disable|revoke`, `prices set|check`,
`credits add --organization <id> --amount <µUSD> --request <id>` and
`account delete|devices|revoke-devices --user <id>`; `serve` belongs to
`deployment`. The organization or user named resolves to its one account
before the command is decided. Sources are develop
`packages/cloud/scripts/admin/` (`preflight-database-identity.ts`,
`mint-subscription-grant-codes.ts`, `revoke-subscription-grants.ts`) and the
products' registration and seeding scripts, which this replaces.

This library decides whether a command may run. The spec that owns each
record checks the command's content, and a command answers what it changed by
count or by the operator's own identifiers.

## Story: Operate the deployment without reading secrets

> As the operator of a deployment, I want to register clients, mint codes,
> set prices, fund pilot accounts and act on a person's request to delete
> their account or sign out a lost device from one command line, so that I
> never need to open a database row, a token or a provider secret to do it.

### Fourteen commands exist, and only credits add and the three account commands name an account

Each command goes through the spec that owns its record. `client register`
registers a client or replaces its registration
(`nativeClients/registry`), so a repeated seed changes nothing. `client apply
--file <path>` applies a reviewed registration file in either environment, as
`RegisterClient`, writes only what changed and prints its receipt
(`nativeClients/registry`, "Story: Apply my app's registration from its
reviewed file"). `grants
revoke --reason <text> (--grant-id <id>… | --code <code>…)` ends each grant
(`billing/grantCodes` `revokeGrant`), and with `--code` also disables the
code.

```quint
import types.* from "./shared/types"
import deployment.* from "./deployment"
import accounts as A from "./identity/accounts"
type OperatorCommand =
  Migrate | RegisterClient | DisableClient | MintGrantCodes | DisableGrantCodes | RevokeGrants
  | SetPrices | CheckPrices | AddCredits | RequestDeletion | ListDevices | RevokeDevices
pure def namesAnAccount(command: OperatorCommand): bool = Set(AddCredits, RequestDeletion, ListDevices, RevokeDevices).contains(command)
```

### A command under a refused profile or on another database is refused before any other check

A command refuses a profile that `deployment` would not start with. Reads
(`prices check`, `account devices`) are refused on another database too,
because they read price or personal rows. The shell reads the connected
database's identity digest; an unreadable one is refused as unavailable,
another one as a failed precondition. `migrate`, like `serve`, reads a
database that holds no table yet as the profile's own, so it stamps a new
database; one that holds tables but no identity is unreadable. A missing
account is `A::Unopened`.

```quint
type OperatorVerdict = Proceed | ExistingDeletion | Refused({ refusal: Refusal })
pure def runs(verdict: OperatorVerdict): bool = match verdict { | Refused(r) => false | Proceed => true | ExistingDeletion => true }
pure def decide(accepted: bool, identity: StoreIdentity, command: OperatorCommand, account: A::AccountStatus, confirmed: bool, count: int): OperatorVerdict =
  if (not(accepted)) Refused({ refusal: refuse(PreconditionFailed) })
  else if (identity == UnreadableDatabase) Refused({ refusal: refuse(ServiceUnavailable) })
  else if (identity == OtherDatabase) Refused({ refusal: refuse(PreconditionFailed) })
  else if (namesAnAccount(command) and account == A::Unopened) Refused({ refusal: refuse(NotFound) })
  else if (command == AddCredits and account != A::Active) Refused({ refusal: refuseFor(AccessDenied, AccountInactive) })
  else if (command == RequestDeletion and not(confirmed)) Refused({ refusal: refuse(InvalidRequest) })
  else if (command == RequestDeletion and account != A::Active) ExistingDeletion
  else if (command == MintGrantCodes and not(mintBatchFits(count))) Refused({ refusal: refuse(InvalidRequest) })
  else Proceed
pure val accountValues: Set[A::AccountStatus] = Set(A::Unopened, A::Active, A::Deleting, A::Erased)
pure def lawDatabaseCheckComesFirst(accepted: bool, identity: StoreIdentity, command: OperatorCommand, account: A::AccountStatus, confirmed: bool, count: int): bool =
  (not(accepted) or identity != MatchingDatabase) implies decide(accepted, identity, command, account, confirmed, count) == decide(accepted, identity, Migrate, A::Unopened, false, 0)
pure def lawEveryOperatorRefusalIsWellFormed(accepted: bool, identity: StoreIdentity, command: OperatorCommand, account: A::AccountStatus, confirmed: bool, count: int): bool = {
  val verdict = decide(accepted, identity, command, account, confirmed, count)
  match verdict { | Refused(r) => wellFormed(r.refusal) | Proceed => true | ExistingDeletion => true }
}
```

### A command runs only under an accepted profile, on the database whose identity the profile names for its environment

Because an accepted profile names a different digest for each environment, a
command never reaches the other environment's database.

```quint
pure def lawCommandsRunOnlyOnTheNamedDatabase(p: Profile, environment: Environment, read: IdentityRead, command: OperatorCommand, account: A::AccountStatus, confirmed: bool, count: int): bool =
  runs(decide(profileAccepted(p), identityOf(p, environment, read), command, account, confirmed, count))
    implies (profileAccepted(p) and read == ReadDigest({ digest: rowOf(p, environment).databaseDigest }))
```

### Credits go only to an active account

Accounts are funded by the operator or by plan allowance; nothing in the
cloud sells credits. The amount (at least 1 µUSD) and the request key that
makes a repeated command change nothing belong to `billing/funds`.

```quint
pure def lawCreditsReachOnlyAnActiveAccount(accepted: bool, identity: StoreIdentity, account: A::AccountStatus, confirmed: bool, count: int): bool =
  runs(decide(accepted, identity, AddCredits, account, confirmed, count)) implies account == A::Active
```

### An account deletion starts only for an active account, after the operator confirmed the request with its owner

The command requires `--confirmed-with-owner`. On an active account it starts
the saga of `identity/deletion`. On an account already deleting or erased it
starts nothing and answers the existing deletion's phase (Fenced to Erased, or
ActionNeeded) and the last receipt of its current phase, by the operator's
identifiers only. After correcting the cause of ActionNeeded, the operator
repeats the confirmed command to resume that step with a fresh budget.

```quint
pure def lawOnlyConfirmedDeletionsStart(accepted: bool, identity: StoreIdentity, account: A::AccountStatus, confirmed: bool, count: int): bool = {
  val verdict = decide(accepted, identity, RequestDeletion, account, confirmed, count)
  (verdict == Proceed implies (confirmed and account == A::Active))
    and (verdict == ExistingDeletion implies (confirmed and Set(A::Deleting, A::Erased).contains(account)))
}
```

### A mint runs only for a batch of 1 to 10,000 codes

The codes are minted in one transaction and printed once, after it commits;
their format, keyed digest and declassification belong to `billing/grantCodes`.

```quint
pure val maxMintBatch: int = 10000
pure def mintBatchFits(count: int): bool = count >= 1 and count <= maxMintBatch
pure val countValues = Set(0, 1, maxMintBatch, maxMintBatch + 1)
pure def lawMintRunsOnlyForABatchThatFits(accepted: bool, identity: StoreIdentity, account: A::AccountStatus, confirmed: bool, count: int): bool =
  runs(decide(accepted, identity, MintGrantCodes, account, confirmed, count)) implies mintBatchFits(count)
```

### The device list shows each key only by its name and dates

`account revoke-devices` ends every device key of the user
(`nativeClients/deviceKeys` `revokeAll`) and every session
(`identity/sessions` `revokeAll`), so a lost device that still holds a session
is signed out too, and answers how many keys it ended. No command shows a
code again, a credential id, a key or its digest, a token or a provider
secret.

```quint
type DeviceRow = { deviceName: str, createdAt: Millis, expiresAt: Millis }
```
