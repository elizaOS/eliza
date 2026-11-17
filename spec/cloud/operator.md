# Operator commands

The operator runs a deployment through the `elizaos-cloud` command line only;
there is no HTTP admin route. The commands are `migrate`, `client
register|update|disable`, `grants mint|disable`, `prices set|refresh|check`,
`credits add`, and `account delete|devices|revoke-devices` (`serve` is
`deployment`). Sources are develop
`packages/cloud/scripts/admin/` (`preflight-database-identity.ts`,
`mint-subscription-grant-codes.ts`, `revoke-subscription-grants.ts`) and the
products' registration and seeding scripts, which this replaces.

This library decides whether a command may run and what its answer may show.
The spec that owns each record checks the command's content: a registration
in `nativeClients/registry`, a grant code in `billing/grantCodes`, a price in
`services/models` and `deployment`, the added credit in `billing/funds`, the
deletion saga in `identity/deletion`, and the revocation epoch in
`nativeClients/deviceKeys`.

## Story: Operate the deployment without reading secrets

> As the operator of a deployment, I want to register clients, mint codes,
> set prices, fund pilot accounts and act on a person's request to delete
> their account or sign out a lost device from one command line, so that I
> never need to open a database row, a token or a provider secret to do it.

### Only checking prices and listing devices leave the database unchanged

Checking prices compares the provider catalog and the price table with the
profile; listing devices reads one user's keys. Every other command, `migrate`
included, writes.

```quint
import types.* from "./shared/types"
type OperatorCommand =
  Migrate | RegisterClient | UpdateClient | DisableClient | MintGrantCodes | DisableGrantCodes
  | SetPrices | RefreshPrices | CheckPrices | AddCredits | RequestDeletion | ListDevices | RevokeDevices
pure def writes(command: OperatorCommand): bool = not(Set(CheckPrices, ListDevices).contains(command))
pure def namesAnAccount(command: OperatorCommand): bool = Set(AddCredits, RequestDeletion, ListDevices, RevokeDevices).contains(command)
```

### A write runs only on the database the profile names, or on a local file store in staging

The shell reads the connected database's identity digest in the session that
writes and compares it with the profile's expected digest for the
environment. A file-backed PGlite store has no digest and is accepted only in
`staging`, for a product's local development. A database whose identity
cannot be read is refused as unavailable; another database is refused as a
failed precondition.

```quint
type ServedEnvironment = Production | Staging
type StoreIdentity = LocalFileStore | MatchingDatabase | OtherDatabase | UnreadableDatabase
pure def storeAdmits(env: ServedEnvironment, identity: StoreIdentity): bool =
  identity == MatchingDatabase or (identity == LocalFileStore and env == Staging)
```

### Credits go only to a live account, from 1 µUSD to 10,000 USD per command

Accounts are funded by the operator or by plan allowance; nothing in the
cloud sells credits. The command names its own request key, so the funds
ledger answers a repeated command with the first entry. The ceiling stops a
mistyped amount; a larger pilot grant is several commands.

```quint
type AccountSeen = LiveAccount | DeletingAccount | ErasedAccount | NoAccount
pure val maxCreditAddition: Micros = 10000 * microsPerUsd
pure def creditAdditionFits(amount: Micros): bool = amount >= 1 and amount <= maxCreditAddition
```

### An account is deleted only after the operator confirmed the request with its owner

The command requires `--confirmed-with-owner`. Requesting the deletion of an
account already being deleted, or erased, answers the deletion that exists.

```quint
pure def deletionMayStart(confirmed: bool, account: AccountSeen): bool = confirmed and account != NoAccount
```

### A mint makes from 1 to 10,000 codes in one transaction, all or none

```quint
pure val maxMintBatch: int = 10000
pure def mintBatchFits(count: int): bool = count >= 1 and count <= maxMintBatch
```

### A command is refused for the first check it fails, the database check before every other

```quint
type OperatorVerdict = Proceed | Refused({ code: RefusalCode, reason: RefusalReason })
pure def refusedWith(code: RefusalCode, reason: RefusalReason): OperatorVerdict = Refused({ code: code, reason: reason })
pure def decide(env: ServedEnvironment, identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, amount: Micros, count: int): OperatorVerdict =
  if (writes(command) and identity == UnreadableDatabase) refusedWith(ServiceUnavailable, NoReason)
  else if (writes(command) and not(storeAdmits(env, identity))) refusedWith(PreconditionFailed, NoReason)
  else if (namesAnAccount(command) and account == NoAccount) refusedWith(NotFound, NoReason)
  else if (command == AddCredits and account != LiveAccount) refusedWith(AccessDenied, AccountInactive)
  else if (command == AddCredits and not(creditAdditionFits(amount))) refusedWith(InvalidRequest, NoReason)
  else if (command == RequestDeletion and not(deletionMayStart(confirmed, account))) refusedWith(InvalidRequest, NoReason)
  else if (command == MintGrantCodes and not(mintBatchFits(count))) refusedWith(InvalidRequest, NoReason)
  else Proceed
pure def lawProductionWritesOnlyTheNamedDatabase(identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, amount: Micros, count: int): bool =
  (writes(command) and decide(Production, identity, command, account, confirmed, amount, count) == Proceed) implies identity == MatchingDatabase
pure def lawDatabaseCheckComesFirst(env: ServedEnvironment, identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, amount: Micros, count: int): bool =
  (writes(command) and identity == OtherDatabase) implies decide(env, identity, command, account, confirmed, amount, count) == refusedWith(PreconditionFailed, NoReason)
pure def lawOnlyConfirmedDeletionsStart(env: ServedEnvironment, identity: StoreIdentity, account: AccountSeen, confirmed: bool, amount: Micros, count: int): bool =
  decide(env, identity, RequestDeletion, account, confirmed, amount, count) == Proceed implies confirmed
pure def lawCreditsReachOnlyALiveAccountWithinBounds(env: ServedEnvironment, identity: StoreIdentity, account: AccountSeen, confirmed: bool, amount: Micros, count: int): bool =
  decide(env, identity, AddCredits, account, confirmed, amount, count) == Proceed implies (account == LiveAccount and amount >= 1 and amount <= maxCreditAddition)
pure def lawEveryOperatorRefusalIsWellFormed(env: ServedEnvironment, identity: StoreIdentity, command: OperatorCommand, account: AccountSeen, confirmed: bool, amount: Micros, count: int): bool = {
  val verdict = decide(env, identity, command, account, confirmed, amount, count)
  match verdict { | Refused(r) => wellFormed({ code: r.code, reason: r.reason, retryAt: NoRetryTime }) | Proceed => true }
}
```

### The operator sees a device only as its name and dates

`account devices` lists the user's live device keys; `account
revoke-devices` moves the user's device epoch and answers how many keys it
ended. Neither shows a credential id, a key or its digest. Other commands
answer what they changed by count or by the operator's own identifiers.

```quint
type DeviceRow = { deviceName: str, createdAt: Millis, expiresAt: Millis }
type OperatorAnswer =
  Applied | DeviceList({ rows: List[DeviceRow] }) | DevicesRevoked({ revoked: int })
  | CodesMinted({ minted: int }) | PriceCheck({ mismatches: int })
```

### A minted code is printed once, when it is minted, and is kept only as a keyed digest

`grants mint` prints each new code on its own line of standard output in the
transaction's success path and keeps only its keyed digest. No command,
answer or log shows a code again, and no command shows a session token, a
device key, a refresh token or a provider secret.

```quint
pure def declassifyMintedCode(code: SecretCode): str = code
```
