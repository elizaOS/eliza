# Aleph AVS (EigenLayer) — what it is and what the contracts expose

## What “Aleph AVS” means (from the contracts repo README)
Aleph AVS is an EigenLayer **Actively Validated Service** that lets delegated restakers allocate stake to external Aleph vaults, while keeping EigenLayer’s security/accountability guarantees in the loop.

In the `AlephFi/avs` repo, the on-chain AVS contract (`AlephAVS`) orchestrates:
- allocation flows into vaults,
- slashing mechanics,
- tokenization of “slashed” positions,
- and unallocation flows back out of vaults.

Source: https://github.com/AlephFi/avs

## Key on-chain objects (as seen in `src/AlephAVS.sol` and `src/IAlephAVS.sol`)
- **Operator**: an EigenLayer operator (checked via `DelegationManager.isOperator(...)`).
- **Strategy**: EigenLayer strategy contracts; AlephAVS tracks “original” and “slashed” strategies per vault.
- **Aleph Vault**: external vault contracts that accept deposits/redemptions.
- **Slashed token / slashed strategy**: a per-vault mechanism used in the allocation/unallocation path.

## User-facing flows (as described in `IAlephAVS`)

### Allocate
`allocate(vault, requestDepositParams)`
- Called by an operator.
- Intention: slash in the relevant operator set/strategy context, deposit into the vault, mint slashed tokens, and coordinate downstream accounting/events.

Related event: `AllocatedToAlephVault(operator, alephVault, originalStrategy, slashedStrategy, tokenAmount, amountToMint, vaultShares, classId)`

### Unallocate (two-step)
The interface documents a two-step flow for holders of slashed strategy tokens:

1) **Request unallocation**
`requestUnallocate(vault, tokenAmount)` (see interface docs in `IAlephAVS.sol`)
- Burns slashed tokens from the caller.
- Requests redemption from the vault.
- Stores the caller’s pending unallocation amount.

Related event: `UnallocateRequested(tokenHolder, alephVault, slashedStrategy, tokenAmount, estAmountToRedeem, batchId, classId)`

2) **Complete unallocation**
`completeUnallocate(vault, ...)` (interface describes this as the second step)
- The contract includes view helpers to check readiness and expected amounts.

View helper in `AlephAVS.sol`:
- `getPendingUnallocateStatus(user, vault) -> (userPendingAmount, totalPendingAmount, redeemableAmount, canComplete)`

Related event: `UnallocateCompleted(tokenHolder, alephVault, originalStrategy, slashedStrategy, amount, shares, classId)`

## Why this matters (tweet-friendly narrative)
- **Separation of concerns**: vaults handle fund operations; AVS coordinates operator-driven allocation/unallocation mechanics.
- **Explicit state transitions**: events and two-step flows make the system auditable.
- **Operator + allocator mental model**: operators act in EigenLayer; allocators interact with vaults; the AVS bridges the two.

## Source pointers
- https://github.com/AlephFi/avs
  - `README.md`
  - `src/IAlephAVS.sol`
  - `src/AlephAVS.sol`

