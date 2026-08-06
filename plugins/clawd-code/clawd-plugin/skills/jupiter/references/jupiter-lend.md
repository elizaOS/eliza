# Jupiter Lend Protocol

## What This Covers

Jupiter Lend (powered by Fluid Protocol) — a lending and borrowing protocol on Solana. Covers the REST API, liquidity pools, lending markets (jlTokens), vaults for leveraged positions, and both the read and write SDKs.

---

## Architecture

### Two-Layer Model

- **Liquidity Layer**: Foundational layer managing token limits, rate curves, and unified liquidity. Users never interact with this directly.
- **Protocol Layer**: User-facing modules (Earn and Borrow) that sit on top of the Liquidity Layer via Cross-Program Invocations (CPIs).

### Key Concepts

- **jlToken**: Yield-bearing token received when supplying to Earn (e.g., `jlUSDC`). Exchange rate increases as interest accrues.
- **Exchange Price**: Conversion rate between raw stored amounts and actual token amounts. Continuously increases.
- **Collateral Factor (CF)**: Maximum LTV ratio allowed when opening/managing positions.
- **Liquidation Threshold (LT)**: LTV at which a position becomes eligible for liquidation.
- **Liquidation Max Limit (LML)**: Absolute maximum LTV — positions exceeding this are absorbed by the protocol.
- **Sentinel Values**: `MAX_WITHDRAW_AMOUNT` and `MAX_REPAY_AMOUNT` — tell the protocol to calculate and use the maximum possible amount. Always use these for full withdrawals/repayments instead of trying to calculate exact amounts.

---

## REST API

All REST endpoints require the `x-api-key` header.

```
Base: https://api.jup.ag/lend/v1
Auth: x-api-key header (required)
```

### Earn Endpoints

```typescript
// Deposit tokens
const depositRes = await fetch('https://api.jup.ag/lend/v1/earn/deposit', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    amount: '1000000', // atomic units
    signer: walletPublicKey,
  }),
});

// Withdraw tokens
const withdrawRes = await fetch('https://api.jup.ag/lend/v1/earn/withdraw', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    amount: '1000000',
    signer: walletPublicKey,
  }),
});

// Get available earn tokens
const tokensRes = await fetch('https://api.jup.ag/lend/v1/earn/tokens', {
  headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
});

// Get user positions
const positionsRes = await fetch(
  `https://api.jup.ag/lend/v1/earn/positions?user=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

// Get earnings history
const earningsRes = await fetch(
  `https://api.jup.ag/lend/v1/earn/earnings?user=${walletPublicKey}`,
  { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
);

// Mint vault shares (specify shares, not underlying amount)
const mintRes = await fetch('https://api.jup.ag/lend/v1/earn/mint', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    shares: '1000000', // vault shares to mint
    signer: walletPublicKey,
  }),
});

// Redeem vault shares back to underlying tokens
const redeemRes = await fetch('https://api.jup.ag/lend/v1/earn/redeem', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    asset: mintAddress,
    shares: '1000000', // vault shares to redeem
    signer: walletPublicKey,
  }),
});
```

### Instruction Endpoints (for Composability)

These return raw instructions instead of full transactions, allowing you to compose earn operations with other instructions in a single transaction.

```typescript
// Deposit instructions
const depositIxRes = await fetch('https://api.jup.ag/lend/v1/earn/deposit-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, amount: '1000000', signer: walletPublicKey }),
});
// Returns: { programId, accounts: [{ pubkey, isSigner, isWritable }], data }

// Withdraw instructions
const withdrawIxRes = await fetch('https://api.jup.ag/lend/v1/earn/withdraw-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, amount: '1000000', signer: walletPublicKey }),
});

// Mint instructions (shares-based)
const mintIxRes = await fetch('https://api.jup.ag/lend/v1/earn/mint-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, shares: '1000000', signer: walletPublicKey }),
});

// Redeem instructions (shares-based)
const redeemIxRes = await fetch('https://api.jup.ag/lend/v1/earn/redeem-instructions', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ asset: mintAddress, shares: '1000000', signer: walletPublicKey }),
});
```

**Transaction vs Instruction endpoints**:
- `/earn/deposit`, `/earn/withdraw`, `/earn/mint`, `/earn/redeem` — return `{ transaction }` (base64-encoded, ready to sign and send)
- `/earn/deposit-instructions`, `/earn/withdraw-instructions`, `/earn/mint-instructions`, `/earn/redeem-instructions` — return `{ programId, accounts, data }` for custom transaction assembly
- **Amount vs Shares**: `/deposit` and `/withdraw` use `amount` (underlying token units). `/mint` and `/redeem` use `shares` (vault share units).

---

## SDKs

```bash
# Read operations (queries, prices, positions)
npm install @jup-ag/lend-read

# Write operations (transactions)
npm install @jup-ag/lend
```

No API key needed for on-chain SDK interactions — only an RPC connection.

---

## Reading Data (@jup-ag/lend-read)

### Initialize Client

```typescript
import { Client } from "@jup-ag/lend-read";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("YOUR_HELIUS_RPC_URL");
const client = new Client(connection);
```

**Important**: Use a Helius RPC URL for reliable access. The user's Helius API key provides the RPC endpoint.

### Liquidity Module — Rates and Pool Data

```typescript
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const data = await client.liquidity.getOverallTokenData(USDC);

// Rates in basis points (10000 = 100%)
const supplyApr = Number(data.supplyRate) / 100;
const borrowApr = Number(data.borrowRate) / 100;
```

### Earn Module — jlToken Markets

```typescript
// Get all fToken (jlToken) details
const allDetails = await client.lending.getFTokensEntireData();

// Get user's jlToken balance
const position = await client.lending.getUserPosition(USDC, userPublicKey);
```

### Borrow Module — Discovery and Positions

```typescript
// Discover all available vaults
const allVaults = await client.vault.getAllVaults();
const totalVaults = await client.vault.getTotalVaults();

// Get vault data (config + state + rates + limits)
const vaultData = await client.vault.getVaultByVaultId(1);

// Check borrowing limits before prompting users
const borrowLimit = vaultData.limitsAndAvailability.borrowLimit;
const borrowable = vaultData.limitsAndAvailability.borrowable;
```

### Finding User Vault Positions

```typescript
const positions = await client.vault.getAllUserPositions(userPublicKey);
// Returns NftPosition[] directly

for (const pos of positions) {
  console.log(`Position NFT ID: ${pos.nftId}`);
  console.log(`Collateral: ${pos.supply}`);
  console.log(`Debt: ${pos.borrow}`);
}
```

---

## Writing Data (@jup-ag/lend)

All write operations return `ixs` (instructions) and `addressLookupTableAccounts` (ALTs). You must wrap these in a **versioned (v0) transaction**.

### Earn — Deposit / Withdraw

```typescript
import { getDepositIxs, getWithdrawIxs } from "@jup-ag/lend/earn";
import BN from "bn.js";

// Deposit 1 USDC (6 decimals)
const { ixs: depositIxs } = await getDepositIxs({
  amount: new BN(1_000_000),
  asset: USDC_PUBKEY,
  signer: userPublicKey,
  connection,
});

// Withdraw
const { ixs: withdrawIxs } = await getWithdrawIxs({
  amount: new BN(100_000),
  asset: USDC_PUBKEY,
  signer: userPublicKey,
  connection,
});
```

### Borrow — Deposit Collateral / Borrow / Repay / Withdraw

All vault operations use the single `getOperateIx` function. The direction is determined by the sign of `colAmount` and `debtAmount`:

| Operation | colAmount | debtAmount |
|---|---|---|
| Deposit collateral | > 0 | 0 |
| Withdraw collateral | < 0 (or `MAX_WITHDRAW_AMOUNT`) | 0 |
| Borrow | 0 | > 0 |
| Repay | 0 | < 0 (or `MAX_REPAY_AMOUNT`) |
| Deposit + Borrow | > 0 | > 0 |
| Repay + Withdraw | `MAX_WITHDRAW_AMOUNT` | `MAX_REPAY_AMOUNT` |

**`positionId: 0`** creates a new position NFT. Use an existing `nftId` (from the read SDK) to operate on an existing position.

```typescript
import { getOperateIx, MAX_WITHDRAW_AMOUNT, MAX_REPAY_AMOUNT } from "@jup-ag/lend/borrow";
import BN from "bn.js";

// Deposit collateral (new position)
const { ixs, addressLookupTableAccounts, nftId } = await getOperateIx({
  vaultId: 1,
  positionId: 0, // 0 = create new position
  colAmount: new BN(1_000_000),
  debtAmount: new BN(0),
  connection,
  signer: userPublicKey,
});

// Borrow against existing position
const { ixs: borrowIxs } = await getOperateIx({
  vaultId: 1,
  positionId: existingNftId,
  colAmount: new BN(0),
  debtAmount: new BN(500_000),
  connection,
  signer: userPublicKey,
});

// Full repay + withdraw (use sentinels)
const { ixs: closeIxs } = await getOperateIx({
  vaultId: 1,
  positionId: existingNftId,
  colAmount: MAX_WITHDRAW_AMOUNT,
  debtAmount: MAX_REPAY_AMOUNT,
  connection,
  signer: userPublicKey,
});
```

### Building and Sending Transactions

```typescript
import {
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// Build versioned transaction
const latestBlockhash = await connection.getLatestBlockhash();
const message = new TransactionMessage({
  payerKey: signer,
  recentBlockhash: latestBlockhash.blockhash,
  instructions: ixs,
}).compileToV0Message(addressLookupTableAccounts ?? []);

const transaction = new VersionedTransaction(message);
transaction.sign([keypair]);

// Submit via Helius Sender for optimal landing
const SENDER_URL = `https://sender.helius-rpc.com/fast?api-key=${HELIUS_API_KEY}`;
const sendRes = await fetch(SENDER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'sendTransaction',
    params: [
      Buffer.from(transaction.serialize()).toString('base64'),
      { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
    ],
  }),
});
```

### Combining Multiple Operations

When merging instructions from multiple `getOperateIx` calls, **deduplicate Address Lookup Tables**:

```typescript
const allAlts = [...alts1, ...alts2];
const seenKeys = new Set<string>();
const mergedAlts = allAlts.filter((alt) => {
  const k = alt.key.toString();
  if (seenKeys.has(k)) return false;
  seenKeys.add(k);
  return true;
});
```

---

## Program IDs (Mainnet)

| Program | Address |
|---|---|
| Liquidity | `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC` |
| Earn | `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` |
| Earn Rewards | `jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar` |
| Borrow | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` |
| Oracle | `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc` |
| Flashloan | `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS` |

---

## Common Pitfalls

1. **Don't calculate exact repay amounts** — Always use `MAX_REPAY_AMOUNT` sentinel for full repayment. Dust borrow amounts make exact calculation unreliable.
2. **Don't forget to deduplicate ALTs** — When combining multiple instructions, duplicate ALTs cause transaction failures.
3. **Always use versioned (v0) transactions** — Non-versioned transactions don't support Address Lookup Tables.
4. **Check borrowable limits before prompting users** — Use the read SDK to verify vault capacity.
5. **Use Helius RPC** — The Lend SDKs need an RPC connection. Helius provides reliable, high-performance endpoints.
6. **`getOperateIx` returns `nftId`** — Not `positionId`. Use the returned `nftId` for subsequent operations on the same position.

---

## Resources

- Jupiter Lend Docs: [dev.jup.ag/docs/lend](https://dev.jup.ag/docs/lend)
- Read SDK: [@jup-ag/lend-read](https://www.npmjs.com/package/@jup-ag/lend-read)
- Write SDK: [@jup-ag/lend](https://www.npmjs.com/package/@jup-ag/lend)
- Smart Contracts: [github.com/Instadapp/fluid-solana-programs](https://github.com/Instadapp/fluid-solana-programs/)
