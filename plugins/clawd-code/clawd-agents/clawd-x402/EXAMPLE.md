# End-to-end example

This walks through the full loop: you register an agent, someone calls it through the gateway, revenue lands in the vault, a cron sweep distributes it.

## 1. Register your agent on-chain

```ts
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../programs/clawd-vault/target/idl/clawd_vault.json";

const connection = new Connection(process.env.HELIUS_RPC!);
const owner = Keypair.fromSecretKey(/* ... */);
const provider = new AnchorProvider(connection, new Wallet(owner), {});
const program = new Program(idl as any, provider);

const manifestCid = /* 64 bytes — your agent's IPFS manifest */;
const endpoint = new TextEncoder().encode("https://my-agent.example.com").slice(0, 128);
const recipients = {
  buyback: new PublicKey(process.env.BUYBACK_OWNER!),
  treasury: new PublicKey(process.env.TREASURY_OWNER!),
  operator: new PublicKey(process.env.OPERATOR_OWNER!),
};

await program.methods
  .registerAgent(
    Array.from(manifestCid),
    Array.from(endpoint),
    { ownerBps: 7000, buybackBps: 1500, treasuryBps: 1000, operatorBps: 500 },
    recipients,
    0b0111,                                    // x402 | mpp | ap2, no a2a (yet)
    [
      { methodHash: methodHashOf("summarize"), amount: new BN("50000") },   // $0.05
      { methodHash: methodHashOf("embed"),     amount: new BN("10000") },   // $0.01
    ],
  )
  .accounts({ owner: owner.publicKey })
  .rpc();
```

## 2. Pin your agent manifest to IPFS

```sh
curl -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" \
  -H "Authorization: Bearer $PINATA_JWT" \
  -H "content-type: application/json" \
  -d @manifest.json

# manifest.json is a standard A2A agent card + our `pricing` extension:
# {
#   "name": "MawdBot summarizer",
#   "description": "Condenses Solana memecoin research into one-liners.",
#   "url": "https://x402.wtf/a2a/<agent-id>",
#   "version": "1.0.0",
#   "skills": [{ "id": "summarize", "name": "Summarize", "description": "..." }],
#   "pricing": { "summarize": { "amount": "50000", "asset": "EPjF...", "protocols": ["x402","mpp"] } }
# }
```

## 3. Caller invokes your agent

```ts
import { clawdFetch } from "@solanaclawd/x402-client";
import { Keypair, Connection } from "@solana/web3.js";

const caller = Keypair.fromSecretKey(/* caller's wallet */);
const conn = new Connection(process.env.HELIUS_RPC!);

const res = await clawdFetch(
  `https://x402.wtf/a2a/${AGENT_ID}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        id: crypto.randomUUID(),
        message: { role: "user", parts: [{ type: "text", text: "Summarize this thread..." }] },
        metadata: { skillId: "summarize" },
      },
    }),
    signer: caller,
    connection: conn,
    maxAmount: 50000n,
    allowedAssets: [process.env.USDC_MINT!],
    onPaymentRequired: async (req) => {
      console.log(`Paying ${req.maxAmountRequired} base units for ${req.resource}`);
      return true;
    },
  },
);

console.log("Task result:", await res.json());
console.log("Settlement sig:", res.signature);
console.log("Receipt CID:", res.receiptCid);
```

## 4. Sweep earnings

Run this on a cron trigger (Cloudflare Workers cron or a Pi somewhere):

```ts
await program.methods
  .distribute(await getVaultBalance(agentPda))
  .accounts({
    agent: agentPda,
    vaultAuthority: vaultAuthorityPda,
    vaultAta,
    ownerAta,
    buybackAta,
    treasuryAta,
    operatorAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

Post-distribute, the buyback ATA holds USDC. A second job swaps it via Jupiter into $CLAWD and sends the result to either (a) the burn address for deflationary buybacks, or (b) a staking reward vault — your call, set by the Squads multisig.

## What a $CLAWD holder gets

If the caller in step 3 holds $CLAWD in the wallet that's paying:

| Balance | Discount | They actually pay |
|---|---|---|
| 0 | 0% | $0.05 |
| 100k $CLAWD | 10% | $0.045 |
| 1M $CLAWD | 25% | $0.0375 |
| 10M $CLAWD | 50% | $0.025 |

The discount is checked and applied before the 402 challenge is built, so the caller never has to request it — it's automatic.
