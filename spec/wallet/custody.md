# Wallet custody

The wallet's keys are made on the device that runs the agent and stay
there. This model holds which accounts the wallet has and whether the
owner has it switched on. The keys are sealed beside it and never enter a
model, a route, a log or the agent's context.

## Story: Hold my own keys on my device

> As the owner, I want my wallet made on my device and sealed there, so
> that nobody, the agent included, can read, replace or export my keys.

### Only the owner makes the wallet, once, with an account for each family

Making a wallet draws one EVM key and one Solana key from the system's
random source and seals both under the launch's storage key before either
address is shown. A host that gave no storage key holds no wallet. The
agent, a route caller without the owner's launch, and a second request
cannot make one. Once made, the accounts never change: no route imports,
replaces or exports a key.

```quint
type Party = Owner | Agent
type Custody = { held: bool, evmAccount: str, solanaAccount: str, on: bool }
pure val initial: Custody = { held: false, evmAccount: "", solanaAccount: "", on: false }
pure def canAdopt(c: Custody, evmAccount: str, solanaAccount: str, sealed: bool, by: Party): bool =
  not(c.held) and by == Owner and sealed and evmAccount != "" and solanaAccount != ""
pure def adopt(c: Custody, evmAccount: str, solanaAccount: str, sealed: bool, by: Party): Custody =
  { held: true, evmAccount: evmAccount, solanaAccount: solanaAccount, on: true }
pure val evmAccountValues = Set("", "0xA1")
pure val solanaAccountValues = Set("", "So1")
pure def alwaysAHeldWalletNamesBothAccounts(c: Custody): bool =
  (c.held iff c.evmAccount != "") and (c.held iff c.solanaAccount != "")
pure def stepHeldAccountsNeverChange(before: Custody, after: Custody): bool =
  before.held implies (after.held and after.evmAccount == before.evmAccount and after.solanaAccount == before.solanaAccount)
pure def sometimesTheWalletIsHeld(c: Custody): bool = c.held
```

### The owner switches the wallet off and on, and off means nothing is read or signed

A wallet that is off gives the agent no wallet action and no wallet
information, signs nothing and reads no chain. The local custody status
still identifies the sealed wallet so its owner can switch it on. The sealed keys and the
accounts stay as they were, so switching it on brings the same wallet back.
Only the owner switches it.

```quint
pure def canSwitchWallet(c: Custody, wanted: bool, by: Party): bool = c.held and by == Owner and c.on != wanted
pure def switchWallet(c: Custody, wanted: bool, by: Party): Custody = { ...c, on: wanted }
pure def walletServes(c: Custody): bool = c.held and c.on
pure def alwaysOnlyAHeldWalletIsOn(c: Custody): bool = c.on implies c.held
pure def lawOnlyTheOwnerMakesTheWallet(c: Custody, evmAccount: str, solanaAccount: str, sealed: bool, by: Party): bool =
  canAdopt(c, evmAccount, solanaAccount, sealed, by) implies (by == Owner and sealed)
pure def lawOnlyTheOwnerSwitchesTheWallet(c: Custody, wanted: bool, by: Party): bool =
  canSwitchWallet(c, wanted, by) implies by == Owner
pure def sometimesTheWalletIsOff(c: Custody): bool = c.held and not(c.on)
pure val eval_witness_sometimesTheWalletIsOff = (("adopt", "0xA1", "So1", true, Owner), ("switchWallet", false, Owner))
```
