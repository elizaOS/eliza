# Metaplex Genesis Agent Token

Launch the one canonical token for a registered Metaplex agent, route creator fees to the agent's onchain wallet, and optionally reserve the first swap for the agent.

This flow uses Metaplex Genesis for the token launch and Metaplex Agent Registry for the permanent agent-token association. It complements Clawd x402:

| Layer | Purpose |
| --- | --- |
| Clawd x402 | Charges wallets and agents per API call. |
| Clawd vault | Splits settled call revenue across owner, buyback, treasury, and operator. |
| Metaplex Genesis | Launches the agent's public bonding-curve token. |
| Metaplex Agent Registry | Permanently links the token to the agent's Core asset. |

## What You Need

| Requirement | Notes |
| --- | --- |
| Registered Metaplex agent | You need the agent Core asset address. |
| Node.js 18+ | Required for native BigInt support. |
| Funded Solana keypair | Pays transaction fees and any first buy. |
| RPC endpoint | Mainnet or devnet. |
| Irys image URL | `token.image` must be `https://gateway.irys.xyz/...`. |

## Install

```sh
npm install @metaplex-foundation/genesis \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults
```

## Umi Setup

```ts
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity } from "@metaplex-foundation/umi";

const umi = createUmi(process.env.SOLANA_RPC_URL!);
const keypair = umi.eddsa.createKeypairFromSecretKey(mySecretKeyBytes);

umi.use(keypairIdentity(keypair));
```

Genesis API calls use the hosted Metaplex API for transaction construction. Umi provides identity and transaction sending; a `genesis()` plugin is not required.

## Launch The Agent Token

```ts
import { createAndRegisterLaunch } from "@metaplex-foundation/genesis/api";

const result = await createAndRegisterLaunch(umi, {}, {
  wallet: umi.identity.publicKey,
  agent: {
    mint: agentAssetAddress,
    setToken: true,
  },
  launchType: "bondingCurve",
  token: {
    name: "Clawd Agent",
    symbol: "CLAWD",
    image: "https://gateway.irys.xyz/your-image-id",
    description: "The canonical token for this Clawd-powered agent.",
    externalLinks: {
      website: "https://x402.wtf",
      twitter: "@solanaclawd",
      telegram: "https://t.me/solanaclawd",
    },
  },
  launch: {},
});

console.log("Token launched");
console.log("Mint address:", result.mintAddress);
console.log("Launch page:", result.launch.link);
```

`createAndRegisterLaunch` performs create, sign, send, and register in sequence. Passing `agent` makes Genesis route creator fees to the agent's Core asset signer PDA and wrap launch transactions in Core execute instructions.

## Permanent Token Warning

`setToken: true` permanently associates the token with the agent. Each agent can only ever have one token. There is no unset, replace, or reassign instruction after confirmation.

Use this rule:

| Situation | `setToken` |
| --- | --- |
| Mainnet final launch | `true` |
| Devnet testing | `false` |
| Unsure about metadata or symbol | `false` |
| Already launched and ready to link later | Use `setAgentTokenV1` through Core execute. |

## First Buy

The first buy reserves the initial curve swap for the agent PDA and waives fees on that purchase.

```ts
const result = await createAndRegisterLaunch(umi, {}, {
  wallet: umi.identity.publicKey,
  agent: {
    mint: agentAssetAddress,
    setToken: true,
  },
  launchType: "bondingCurve",
  token: {
    name: "Clawd Agent",
    symbol: "CLAWD",
    image: "https://gateway.irys.xyz/your-image-id",
  },
  launch: {
    firstBuyAmount: 0.1,
  },
});
```

If `firstBuyAmount` is omitted or `0`, no reserved first swap is applied and any wallet can make the first buy.

## Devnet

```ts
const umi = createUmi("https://api.devnet.solana.com");

const result = await createAndRegisterLaunch(umi, {}, {
  wallet: umi.identity.publicKey,
  agent: {
    mint: agentAssetAddress,
    setToken: false,
  },
  launchType: "bondingCurve",
  network: "solana-devnet",
  token: {
    name: "Test Agent",
    symbol: "TEST",
    image: "https://gateway.irys.xyz/test-image",
  },
  launch: {},
});
```

Use `setToken: false` on devnet unless you intentionally want to lock that devnet agent to the test token.

## Error Handling

```ts
import {
  createAndRegisterLaunch,
  isGenesisApiError,
  isGenesisApiNetworkError,
  isGenesisValidationError,
} from "@metaplex-foundation/genesis/api";

try {
  const result = await createAndRegisterLaunch(umi, {}, input);
  console.log(result.mintAddress);
} catch (err) {
  if (isGenesisValidationError(err)) {
    console.error(`Validation error on "${err.field}": ${err.message}`);
  } else if (isGenesisApiNetworkError(err)) {
    console.error("Network error:", err.message);
  } else if (isGenesisApiError(err)) {
    console.error(`API error (${err.statusCode}): ${err.message}`);
    console.error("Details:", err.responseBody);
  } else {
    throw err;
  }
}
```

Common failure points:

| Failure | Fix |
| --- | --- |
| Non-Irys image URL | Upload to Irys and use `https://gateway.irys.xyz/<id>`. |
| Name over 32 chars | Shorten `token.name`. |
| Symbol over 10 chars | Shorten `token.symbol`. |
| API/network error | Retry with backoff or check Metaplex API availability. |
| Created but not registered | Use lower-level `createLaunch` and `registerLaunch` recovery flow. |

## How It Fits Clawd

1. Register the agent and get its Core asset address.
2. Launch the canonical Genesis token with the agent field.
3. Register the same agent in the Clawd x402 vault.
4. Use x402 for paid calls.
5. Use Genesis creator-fee claims and Clawd vault distributions as separate revenue streams.

This gives the agent two economic loops: paid work through x402 and token-market activity through Genesis.
