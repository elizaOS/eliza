# @elizaos/plugin-elizamaker

Adds an ERC-8041 NFT drop system to an Eliza agent: public and whitelist minting plus Twitter/X-verified Merkle proofs, exposed as HTTP API routes on the agent server.

## What this plugin does

When enabled, the plugin exposes HTTP API routes directly on the agent's server. These routes let users:

- Check drop phase status (is public/whitelist mint open, current supply, shiny price)
- Mint a free ERC-8041 agent NFT (agent wallet pays gas)
- Mint a "shiny" variant (0.1 ETH + gas)
- Mint with a whitelist Merkle proof for whitelisted wallets
- Verify Twitter/X ownership to join the whitelist (via a public tweet containing their wallet address + `#ElizaAgent`)
- Query current Merkle root and generate proofs for any address

The package also exports Eliza NFT holder-check helpers (`verifyElizaHolder` / `verifyAndWhitelistHolder` in `nft-verify.ts`), but no HTTP route currently invokes them.

## Actions / capabilities added

| Route | What it does |
|---|---|
| `GET /api/drop/status` | Drop flags, supply, shiny price, whether agent wallet has minted |
| `POST /api/drop/mint` | Free public mint; `{ name, endpoint, shiny? }` |
| `POST /api/drop/mint-whitelist` | Whitelist mint; proof auto-generated from agent wallet if omitted |
| `GET /api/whitelist/status` | Verification state and Merkle info for the agent EVM wallet |
| `POST /api/whitelist/twitter/message` | Returns the tweet text the user must post |
| `POST /api/whitelist/twitter/verify` | Confirms the tweet and marks the wallet whitelisted; `{ tweetUrl }` |
| `GET /api/whitelist/merkle/root` | Current root and address count |
| `GET /api/whitelist/merkle/proof` | Proof for `?address=<evm>` |

## Requirements

- An EVM wallet configured for the agent (`EVM_PRIVATE_KEY`)
- A deployed ERC-8041 collection contract
- A JSON-RPC endpoint for the network the contract lives on
- The eliza config file (`~/.eliza/eliza.json` by default) must include:

```json
{
  "registry": {
    "registryAddress": "0x...",
    "collectionAddress": "0x...",
    "mainnetRpc": "https://your-rpc-url"
  },
  "features": {
    "dropEnabled": true
  }
}
```

If `EVM_PRIVATE_KEY`, `registryAddress`, or `mainnetRpc` are missing, the plugin loads silently but all drop/mint routes return 503. The whitelist and Merkle routes still work without a contract connection.

## Enabling the plugin

Add to your agent's plugin list:

```ts
import { elizaMakerPlugin } from "@elizaos/plugin-elizamaker";

const agent = new AgentRuntime({
  plugins: [elizaMakerPlugin],
  // ...
});
```

Or reference it by package name in your agent character config if the runtime supports string-based plugin loading.

## Whitelist flow

1. Call `POST /api/whitelist/twitter/message` — get the verification message.
2. Post it on X (Twitter) exactly as returned.
3. Call `POST /api/whitelist/twitter/verify` with `{ "tweetUrl": "https://x.com/..." }`.
4. On success the wallet is added to `whitelist.json` in the agent state dir.
5. Call `GET /api/whitelist/merkle/proof` to get the `bytes32[]` proof, then submit with `POST /api/drop/mint-whitelist`.

Note: `nft-verify.ts` exports `verifyElizaHolder` / `verifyAndWhitelistHolder` for NFT-based whitelisting, but these are not wired to any route. The `nftVerified` field returned by `GET /api/whitelist/status` is currently an alias of the Twitter verification state.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `EVM_PRIVATE_KEY` | — | Required for mint transactions; set as agent runtime setting |
| `ELIZA_NFT_RPC_URL` | `https://mainnet.base.org` | Override RPC for Eliza NFT holder check |

## Building

```bash
bun run --cwd plugins/plugin-elizamaker build
```
