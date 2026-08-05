# Integration Patterns — Helius x Jupiter

## What This Covers

End-to-end patterns for combining Jupiter APIs with Helius infrastructure. These patterns show how the two systems connect at the transaction, data, and monitoring layers.

**Jupiter** handles DeFi operations — token swaps (Swap API V2), lending/borrowing (Lend), limit orders (Trigger), DCA (Recurring), and token/price data.

**Helius** handles infrastructure — transaction submission (Sender), fee optimization (Priority Fees), token/NFT data (DAS), real-time on-chain monitoring (WebSockets), shred-level streaming (LaserStream), and wallet intelligence (Wallet API).

---

## Pattern 1: Jupiter Swap via Helius Sender

Helius Sender dual-routes a transaction to validators **and** Jito simultaneously. The Jito leg requires a tip transfer **inside the transaction** — which Jupiter's `/order` pre-built transaction does **not** include. This pattern uses `/swap/v2/build` to get raw instructions, then locally assembles a V0 transaction with the tip transfer before submitting via Sender.

### Flow

1. `GET /swap/v2/build` with `inputMint`, `outputMint`, `amount`, `taker`.
2. From the response, collect: `computeBudgetInstructions` (Jupiter's CU-price ix), `setupInstructions`, `swapInstruction`, `cleanupInstruction`, `otherInstructions`, `addressesByLookupTableAddress`, and `blockhashWithMetadata`.
3. **Compute unit limit:** simulate first, then set the real limit. Build a probe message with `setComputeUnitLimit(1_400_000)`, run `simulateTransaction` against the Helius RPC, and on the real transaction set `setComputeUnitLimit(Math.min(Math.ceil(simulatedUnits * 1.2), 1_400_000))`. Do **not** hardcode 1.4M on the real transaction — over-allocating CUs lowers per-CU priority.
4. Keep Jupiter's `computeBudgetInstructions` (CU price) as-is — do not replace.
5. Append `SystemProgram.transfer({ fromPubkey: taker, toPubkey: randomJitoTipAccount, lamports: Math.floor(tipAmountSOL * LAMPORTS_PER_SOL) })` after cleanup/other instructions. Use `getDynamicTipAmount()` from `references/helius-sender.md` — it returns **SOL** (floor `0.0002 SOL` = 200,000 lamports), so convert to lamports before constructing the transfer. Pick a random tip account from the 10-address mainnet list in `references/helius-sender.md`.
6. Reconstruct `AddressLookupTableAccount[]` directly from `addressesByLookupTableAddress` — no extra `getAddressLookupTable` RPC fetch. Each key is the ALT address, value is the `addresses[]`.
7. **Blockhash:** use `blockhashWithMetadata.blockhash` from the `/build` response by default — it is fresh as of the Jupiter call and saves an RPC round-trip. Only call `getLatestBlockhash` against the Helius RPC if more than ~30 seconds elapse between `/build` and submission (e.g. wallet UI signature delays), since stale blockhashes cause Sender to reject on the validator leg.
8. Build `TransactionMessage` → `compileToV0Message(altAccounts)` → `VersionedTransaction`. Sign and submit to Helius Sender with `skipPreflight: true, maxRetries: 0` (mandatory — see `references/helius-sender.md`).

### TypeScript Example

```typescript
import {
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
  AddressLookupTableAccount,
  Keypair,
  Connection,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

const JUPITER_API = 'https://api.jup.ag';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const SENDER_URL = `https://sender.helius-rpc.com/fast?api-key=${process.env.HELIUS_API_KEY}`;

// See references/helius-sender.md for the full 10-address mainnet list.
const JITO_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

async function getDynamicTipAmount(): Promise<number> {
  try {
    const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
    const data = await res.json();
    if (data?.[0]?.landed_tips_75th_percentile) {
      return Math.max(data[0].landed_tips_75th_percentile, 0.0002);
    }
  } catch {}
  return 0.0002;
}

function decodeIx(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

async function swapViaJupiterAndSender(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<string> {
  const taker = keypair.publicKey;
  const connection = new Connection(HELIUS_RPC);

  // 1. /build — raw instructions (no Jito tip, no CU limit)
  const params = new URLSearchParams({ inputMint, outputMint, amount, taker: taker.toBase58() });
  const buildRes = await fetch(`${JUPITER_API}/swap/v2/build?${params}`, {
    headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
  });
  const build = await buildRes.json();
  if (build.error) throw new Error(`Jupiter /build error: ${build.error}`);

  // 2. Reconstruct ALTs directly from the response — no extra RPC fetch.
  const altAccounts: AddressLookupTableAccount[] = Object.entries(
    build.addressesByLookupTableAddress as Record<string, string[]>,
  ).map(([key, addresses]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: BigInt('0xffffffffffffffff'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: addresses.map((a) => new PublicKey(a)),
    },
  }));

  // 3. Collect Jupiter instructions in order.
  const jupiterIxs: TransactionInstruction[] = [
    ...(build.computeBudgetInstructions ?? []).map(decodeIx), // CU price ix (keep as-is)
    ...(build.setupInstructions ?? []).map(decodeIx),
    decodeIx(build.swapInstruction),
    ...(build.cleanupInstruction ? [decodeIx(build.cleanupInstruction)] : []),
    ...(build.otherInstructions ?? []).map(decodeIx),
  ];

  // 4. Jito tip transfer — required for Sender dual-routing. getDynamicTipAmount() returns SOL.
  const tipAmountSOL = await getDynamicTipAmount();
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
  const tipIx = SystemProgram.transfer({
    fromPubkey: taker,
    toPubkey: tipAccount,
    lamports: Math.floor(tipAmountSOL * LAMPORTS_PER_SOL),
  });

  // 5. Use Jupiter's blockhash (fresh as of /build). Refresh only if you sit on this for >~30s.
  const blockhash = build.blockhashWithMetadata.blockhash;

  // 6. Simulate with the 1.4M ceiling to measure actual CU usage.
  const probeMsg = new TransactionMessage({
    payerKey: taker,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...jupiterIxs, tipIx],
  }).compileToV0Message(altAccounts);
  const probeTx = new VersionedTransaction(probeMsg);
  // No need to sign — simulateTransaction is called with sigVerify: false and replaceRecentBlockhash: true.
  const sim = await connection.simulateTransaction(probeTx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
  const cuLimit = Math.min(Math.ceil((sim.value.unitsConsumed ?? 200_000) * 1.2), 1_400_000);

  // 7. Real transaction with the simulated CU limit.
  const realMsg = new TransactionMessage({
    payerKey: taker,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...jupiterIxs, tipIx],
  }).compileToV0Message(altAccounts);
  const tx = new VersionedTransaction(realMsg);
  tx.sign([keypair]);

  // 8. Submit via Helius Sender. skipPreflight + maxRetries:0 are mandatory.
  const sendRes = await fetch(SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [
        Buffer.from(tx.serialize()).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ],
    }),
  });
  const sendResult = await sendRes.json();
  if (sendResult.error) throw new Error(`Sender error: ${sendResult.error.message}`);
  return sendResult.result; // transaction signature
}
```

See `references/jupiter-swap.md` for the full `/build` response shape, and `references/helius-sender.md` for the complete tip account list, dynamic tip sizing, and the mandatory Sender submission requirements.

### When to Use `/order` + `/execute` vs `/build` + Helius Sender

- **`/order` + `/execute`** — Jupiter manages submission (Beam), including Jito landing internally — you do not (and cannot) add a tip ix to the returned transaction. Idempotent retries via `requestId`. Use when you do not need custom transaction composition or direct control over the Jito tip.
- **`/build` + Helius Sender** — You assemble the transaction (compute budget, swap, tip, ALTs) and submit through Sender for Jito + SWQoS dual-routing. Use when you need a Jito tip inside the transaction, custom priority fees, or composition with non-Jupiter instructions.

---

## Pattern 2: Token Selector with DAS + Jupiter

Build a swap UI token selector combining user holdings from Helius with Jupiter metadata and prices.

### Flow

1. Fetch user's token holdings via Helius DAS (`getAssetsByOwner`)
2. Enrich with Jupiter token metadata (verification, logos)
3. Get live prices from Jupiter Price API v3
4. Display sorted by value with verification badges

### TypeScript Example

```typescript
// Step 1: Get user holdings via Helius MCP
// Use getAssetsByOwner with showFungible: true
// Returns: array of assets with mint, amount, decimals

// Step 2: Enrich with Jupiter metadata
const mintAddresses = holdings.map(h => h.mint);

// Step 3: Batch price lookup (max 50 per request)
const chunks = [];
for (let i = 0; i < mintAddresses.length; i += 50) {
  chunks.push(mintAddresses.slice(i, i + 50));
}

const allPrices: Record<string, number> = {};
for (const chunk of chunks) {
  const res = await fetch(
    `https://api.jup.ag/price/v3?ids=${chunk.join(',')}`,
    { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } }
  );
  const data = await res.json();
  // Price API v3 keys mints at the top level — no `data` wrapper
  for (const [mint, info] of Object.entries(data)) {
    allPrices[mint] = (info as any).usdPrice;
  }
}

// Step 4: Combine and sort by USD value
const enrichedHoldings = holdings.map(h => ({
  ...h,
  price: allPrices[h.mint] || 0,
  usdValue: (h.amount / Math.pow(10, h.decimals)) * (allPrices[h.mint] || 0),
})).sort((a, b) => b.usdValue - a.usdValue);
```

---

## Pattern 3: Lending Position with Helius Monitoring

Deposit tokens into Jupiter Lend and monitor the position with Helius WebSockets.

### Flow

1. Query vault data via Jupiter Lend read SDK
2. Build deposit transaction via write SDK
3. Submit via Helius Sender
4. Monitor position changes via Helius WebSockets

### TypeScript Example

```typescript
import { Client } from "@jup-ag/lend-read";
import { getOperateIx } from "@jup-ag/lend/borrow";
import BN from "bn.js";

// 1. Query vault data
const connection = new Connection(HELIUS_RPC_URL);
const client = new Client(connection);
const vaultData = await client.vault.getVaultByVaultId(targetVaultId);

// Check limits before proceeding
if (depositAmount > vaultData.limitsAndAvailability.supplyLimit) {
  throw new Error('Deposit exceeds vault supply limit');
}

// 2. Build deposit transaction
const { ixs, addressLookupTableAccounts, nftId } = await getOperateIx({
  vaultId: targetVaultId,
  positionId: 0, // new position
  colAmount: new BN(depositAmount),
  debtAmount: new BN(0),
  connection,
  signer: userPublicKey,
});

// 3. Build, sign, submit via Helius Sender
// (See Pattern 1 for Sender submission code)

// 4. Monitor position via Helius WebSockets
// Use accountSubscribe MCP tool to watch the position account
// Trigger alerts when LTV approaches liquidation threshold
```

---

## Pattern 4: Limit Order + DCA with Status Tracking

Set up limit orders and DCA orders, then track their execution status.

### Flow

1. Authenticate via JWT challenge-response (Trigger V2)
2. Register vault and craft deposit transaction
3. Create orders via Jupiter Trigger V2 / Recurring APIs
4. Use Helius `parseTransactions` to get human-readable execution history
5. Use Helius WebSockets to get real-time notifications when orders fill

```typescript
// 1. Authenticate (see references/jupiter-trigger.md for full JWT flow)
const { token: jwtToken } = await authenticateJupiterTrigger(walletPublicKey, wallet);

// 2. Craft deposit and create a limit order (Trigger V2)
const depositRes = await fetch('https://api.jup.ag/trigger/v2/deposit/craft', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    userAddress: walletPublicKey,
    amount: '1000000000', // 1 SOL
  }),
});
const deposit = await depositRes.json();

// Sign the deposit transaction
const depositTx = VersionedTransaction.deserialize(Buffer.from(deposit.transaction, 'base64'));
depositTx.sign([keypair]);
const depositSignedTx = Buffer.from(depositTx.serialize()).toString('base64');

// 3. Create the order
const orderRes = await fetch('https://api.jup.ag/trigger/v2/orders/price', {
  method: 'POST',
  headers: {
    'x-api-key': process.env.JUPITER_API_KEY!,
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    orderType: 'single',
    depositRequestId: deposit.requestId,
    depositSignedTx,
    userPubkey: walletPublicKey,
    inputMint: SOL_MINT,
    inputAmount: '1000000000',
    outputMint: USDC_MINT,
    triggerMint: SOL_MINT,
    triggerCondition: 'above',
    triggerPriceUsd: 200, // Sell when SOL > $200
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  }),
});
const order = await orderRes.json();
// order: { id, txSignature }

// 4. Check order execution history via Helius
// Use parseTransactions MCP tool with the wallet address
// Jupiter order fills show as "SWAP" transaction types
```

---

## Pattern 5: Portfolio Dashboard with DeFi Positions

Build a comprehensive dashboard showing token holdings, lending positions, and open orders.

### Architecture

```
Helius Wallet API   →  Token holdings + USD values
Helius DAS API      →  Token metadata + NFT positions
Jupiter Lend Read   →  Lending positions + yield data
Jupiter Trigger V2  →  Open limit orders (requires JWT)
Jupiter Recurring   →  Active DCA orders
Jupiter Price API   →  Live price feeds
```

### Data Flow

```typescript
// Parallel data fetching for dashboard
const [walletBalances, lendPositions, limitOrders, dcaOrders] = await Promise.all([
  // Helius: wallet holdings
  heliusWalletBalances(walletAddress),
  // Jupiter Lend: vault positions
  lendClient.vault.getAllUserPositions(walletPublicKey),
  // Jupiter Trigger V2: open limit orders (requires JWT auth)
  fetch('https://api.jup.ag/trigger/v2/orders/history?state=active', {
    headers: {
      'x-api-key': JUPITER_API_KEY,
      'Authorization': `Bearer ${jwtToken}`,
    },
  }).then(r => r.json()),
  // Jupiter Recurring: active DCA orders
  fetch(`https://api.jup.ag/recurring/v1/getRecurringOrders?user=${walletAddress}&orderStatus=active&recurringType=time`, {
    headers: { 'x-api-key': JUPITER_API_KEY },
  }).then(r => r.json()),
]);
```

---

## Pattern 6: Trading Bot with LaserStream

Build a high-speed trading bot using LaserStream for market data and Jupiter Swap API for execution.

### Architecture

```
LaserStream (gRPC)  →  Shred-level on-chain data (price changes, liquidity shifts)
Jupiter Swap API API   →  Swap execution with optimized routing
Helius Sender       →  Transaction submission with Jito bundles
```

### Flow

1. Subscribe to relevant accounts via LaserStream
2. Detect trading opportunity (price divergence, arbitrage, etc.)
3. Get quote from Jupiter Swap API
4. Sign and submit via Helius Sender
5. Monitor confirmation via LaserStream

```typescript
import { subscribe } from 'helius-laserstream';

// 1. Subscribe to pool accounts for price monitoring
const config = {
  apiKey: process.env.HELIUS_API_KEY!,
  endpoint: 'mainnet', // or regional endpoint for lower latency
};

const request = {
  accounts: [POOL_ACCOUNT_ADDRESS],
  commitment: 'confirmed',
};

subscribe(config, request,
  // Data callback
  async (update) => {
    // 2. Detect opportunity
    const opportunity = analyzeUpdate(update);
    if (!opportunity) return;

    // 3. Execute swap via Jupiter
    const signature = await swapViaJupiterAndSender(
      keypair,
      opportunity.inputMint,
      opportunity.outputMint,
      opportunity.amount,
    );

    console.log(`Trade executed: ${signature}`);
  },
  // Error callback
  (error) => {
    console.error('LaserStream error:', error);
  }
);
```

### Latency Considerations

- Choose the **closest LaserStream regional endpoint** to your server
- Use `CONFIRMED` commitment (faster than `FINALIZED`)
- Pre-build transactions where possible to minimize execution time
- LaserStream requires **Professional plan** ($999/mo) on mainnet

---

## Pattern 7: Jupiter Plugin with Helius Portfolio

The fastest path to adding swap functionality — use Jupiter's drop-in widget with Helius for portfolio context.

### Flow

1. Fetch user's token holdings via Helius DAS
2. Display portfolio in your app
3. Initialize Jupiter Plugin with Helius RPC
4. Let users click tokens to pre-fill swap parameters
5. Monitor completed swaps via Helius parseTransactions

### TypeScript Example (React)

```typescript
import '@jup-ag/plugin/css';
import { useEffect, useState } from 'react';

function SwapPage({ walletAddress }: { walletAddress: string }) {
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [holdings, setHoldings] = useState([]);

  useEffect(() => {
    // Fetch holdings via Helius (getAssetsByOwner MCP tool)
    fetchHoldings(walletAddress).then(setHoldings);
  }, [walletAddress]);

  useEffect(() => {
    import('@jup-ag/plugin').then(({ init }) => {
      init({
        displayMode: 'integrated',
        integratedTargetId: 'jupiter-plugin',
        endpoint: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        defaultExplorer: 'Solana Explorer',
        formProps: selectedMint ? { initialInputMint: selectedMint } : undefined,
      });
    });
  }, [selectedMint]);

  return (
    <div>
      {/* Portfolio list — click to swap */}
      <div>
        {holdings.map(token => (
          <div key={token.mint} onClick={() => setSelectedMint(token.mint)}>
            {token.symbol}: {token.balance} (${token.usdValue})
          </div>
        ))}
      </div>

      {/* Jupiter swap widget */}
      <div id="jupiter-plugin" style={{ width: 400, height: 600 }} />
    </div>
  );
}
```

### Helius Value

- **Helius RPC** powers the plugin's transaction submission
- **DAS API** provides the portfolio context surrounding the swap
- **parseTransactions** gives rich post-swap transaction details
- **Wallet API** keeps the portfolio view updated after swaps

---

## Cross-Pattern Best Practices

1. **Always use Helius RPC** for Jupiter Lend SDK connections — provides reliable, high-performance access
2. **Batch API calls** — Jupiter Price API (max 50 per request), Helius DAS batch endpoints
3. **Handle errors at each layer** — Jupiter API errors, Sender errors, and on-chain errors are different
4. **Use environment variables** for all API keys — never hardcode
5. **Log with context** — Include requestId, signature, and timestamps for debugging
6. **Respect rate limits** — Jupiter limits are dynamic; Helius limits depend on plan tier
7. **Use Jupiter Plugin for quick swap UIs** — Don't build swap from scratch unless you need custom routing control
8. **Check Token Shield before displaying tokens** — Combine with Helius DAS metadata for comprehensive safety checks
9. **For perps, read on-chain accounts via Helius** — No REST API exists; use `getAccountInfo` and `getProgramAccounts`
