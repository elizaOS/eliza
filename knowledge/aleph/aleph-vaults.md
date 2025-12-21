# Aleph Vaults (mental model + key flows)

## What an Aleph Vault is
Aleph Vaults wrap yield strategies into **fund shares** whose value is derived from NAV (net asset value). Vault operations are built around **request + settlement** rather than instant execution.

Key properties called out in the docs:
- **Asynchronous settlement**: deposits/redemptions are requested on-chain and then settled in batches after NAV updates.
- **Canonical states**: settlement produces a single per-share price for a batch.
- **Built-in compliance controls**: whitelisting / KYC-style gating can be enforced.
- **Fee controls**: fees can be configured per share class/series and collected by an accountant role.

## Roles (as described across docs)
- **Manager**: configures vault parameters, runs NAV updates, and initiates settlement cycles.
- **Allocator**: completes onboarding and submits deposit/redeem requests.
- **Operations / guardian**: administrative + emergency pause roles (flow-specific pausing).
- **Accountant**: collects fees and manages configured fee splits.

## High-level flow of funds (from product docs)
1. Manager deploys a vault with customized controls.
2. Allocator completes onboarding (KYC/AML + approvals).
3. Allocator requests a deposit.
4. Manager publishes an updated NAV and settles deposits.
5. Assets transfer to the custodian; allocator receives shares proportional to AUM.
6. Manager runs the underlying strategies.
7. Allocator requests redemption; manager settles redemptions (NAV + fees).
8. Returns are distributed; shares are burned as appropriate.

## Vault configuration (developer docs)
Vault initialization parameters are organized into:
- **Core parameters** (ops multisig, factory, oracle, guardian, auth signer, accountant, batch duration)
- **User-provided parameters** (name, configId, manager, underlying token, custodian, vault treasury, share class params)
- **Module implementations** (deposit/redeem/settlement, fee manager, migration manager)

Examples of key methods called out in docs:
- Toggle gating: `setIsDepositAuthEnabled(bool)`, `setIsSettlementAuthEnabled(bool)`
- New share classes: `createShareClass(ShareClassParams)` returns `classId`
- Upgrade modules: `migrateModules(bytes4 module, address newImplementation)`
- Fee lifecycle: queue + set management/performance fees, `collectFees()`
- Flow-level controls: `pause(bytes4 flow)` / `unpause(bytes4 flow)` for specific flows
- User actions: `requestDeposit(...)`, `requestRedeem(...)`, and settlement calls by manager roles

## Vault factory (developer docs)
Vaults are deployed via the factory’s `deployVault(...)` which takes user initialization parameters like:
name, configId, manager, underlying token, custodian, vault treasury, and share class fee/limit parameters.

## Source pointers
- https://github.com/AlephFi/docs
  - `product/aleph-vehicle/aleph-vault.md`
  - `developer/aleph-vault.md`
  - `developer/aleph-vault-factory.md`
  - `learn/user-guides/manager/create-vault.md`

