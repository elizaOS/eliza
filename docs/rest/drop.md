---
title: "Drop & Whitelist API"
sidebarTitle: "Drop"
description: "REST API endpoints for NFT drop minting and Twitter-based whitelist verification."
---

The drop and whitelist API handles NFT minting for public and whitelisted drops, plus a Twitter-based verification flow for adding addresses to the whitelist.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/drop/status` | Get current drop status and metadata |
| POST | `/api/drop/mint` | Mint an NFT from the public drop |
| POST | `/api/drop/mint-whitelist` | Mint an NFT using a whitelist spot |
| GET | `/api/whitelist/status` | Check whitelist verification status for an address |
| POST | `/api/whitelist/twitter/message` | Generate a verification tweet message |
| POST | `/api/whitelist/twitter/verify` | Verify a tweet to whitelist an address |

---

### GET /api/drop/status

Returns the current state of the NFT drop — whether it is active, supply remaining, price, and related metadata.

**Response**

```json
{
  "dropEnabled": false,
  "publicMintOpen": false,
  "whitelistMintOpen": false,
  "mintedOut": false,
  "currentSupply": 0,
  "maxSupply": 2138,
  "shinyPrice": "0.1",
  "userHasMinted": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dropEnabled` | boolean | Whether the drop feature is active |
| `publicMintOpen` | boolean | Whether public minting is currently open |
| `whitelistMintOpen` | boolean | Whether whitelist minting is currently open |
| `mintedOut` | boolean | Whether all tokens have been minted |
| `currentSupply` | number | Number of tokens minted so far |
| `maxSupply` | number | Maximum token supply |
| `shinyPrice` | string | Mint price as a decimal string |
| `userHasMinted` | boolean | Whether the connected user has already minted |

---

### POST /api/drop/mint

Mint an NFT from the public (non-whitelisted) drop.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | Yes | Wallet address to receive the NFT |
| `quantity` | number | No | Number of NFTs to mint (default 1) |

**Response**

```json
{
  "ok": true,
  "txHash": "0xabc123...",
  "tokenId": 343
}
```

---

### POST /api/drop/mint-whitelist

Mint an NFT using a whitelist allocation. The address must have been previously verified.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | Yes | Whitelisted wallet address |
| `quantity` | number | No | Number of NFTs to mint (default 1) |

**Response**

```json
{
  "ok": true,
  "txHash": "0xdef456...",
  "tokenId": 344
}
```

---

### GET /api/whitelist/status

Check whitelist eligibility for the connected wallet address.

**Response**

```json
{
  "eligible": false,
  "twitterVerified": false,
  "ogCode": null,
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `eligible` | boolean | Whether the wallet is eligible for whitelist minting |
| `twitterVerified` | boolean | Whether the wallet has been verified via Twitter |
| `ogCode` | string\|null | OG verification code, if applicable |
| `walletAddress` | string | The wallet address being checked |

---

### POST /api/whitelist/twitter/message

Generate a verification message that the user must tweet to prove wallet ownership.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | Yes | Wallet address to verify |

**Response**

```json
{
  "message": "Verifying my wallet 0x1234...abcd for @ElizaAgent whitelist #eliza-verify-abc123"
}
```

---

### POST /api/whitelist/twitter/verify

Submit a tweet URL for verification. The server fetches the tweet, validates the verification message content, and adds the address to the whitelist if valid.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string | Yes | Wallet address being verified |
| `tweetUrl` | string | Yes | URL of the verification tweet |

**Response**

```json
{
  "ok": true,
  "whitelisted": true
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing address or tweet URL |
| 400 | Tweet does not contain the expected verification message |
| 400 | Tweet author does not match expectations |

---

## Operational Runbook

### Setup Checklist

1. Configure drop contract/network settings: `EVM_PRIVATE_KEY`, `mainnetRpc`, `registryAddress`, and `collectionAddress` in agent config.
2. Ensure signer wallet has sufficient gas balance on the target chain.
3. Configure Twitter verification integration: the FxTwitter API (`api.fxtwitter.com`) must be reachable for whitelist tweet verification.
4. Verify the runtime can reach RPC endpoints and social verification providers from the deployment environment.
5. Confirm the whitelist state file (`~/.eliza/whitelist.json`, controlled by `ELIZA_STATE_DIR`) is writable for persisting verified addresses.

### Failure Modes

**On-chain operations:**

- Mint request reverts or times out:
  Check signer funding, nonce state, and gas policy. Verify `mainnetRpc` is reachable and not rate-limited. The tx-service retries with escalating gas — if all retries fail, the error includes the revert reason.
- Nonce conflict on sequential transactions:
  The tx-service manages nonce locally. If an external wallet transaction changes the nonce, restart the agent to re-sync.
- Contract call returns empty data:
  Confirm `registryAddress` and `collectionAddress` point to deployed contracts on the correct chain.

**Whitelist verification:**

- Tweet URL parsing fails:
  The verifier expects URLs matching `twitter.com/<user>/status/<id>` or `x.com/<user>/status/<id>`. Query parameters and trailing path segments are stripped. Malformed URLs return 400.
- Author validation fails:
  The tweet author must match the expected handle. FxTwitter returns the canonical username — case-insensitive comparison is used.
- Content matching fails:
  The tweet text must contain the expected wallet address. The verifier checks for full address prefix match — partial/suffix-only matches are rejected.
- FxTwitter API unreachable:
  The verifier fetches tweet data from `api.fxtwitter.com`. If the API is down or rate-limited, verification fails with a network error.

**State persistence:**

- Status endpoint stale or inconsistent:
  Check drop service initialization and cache invalidation behavior.
- Corrupted whitelist JSON:
  `loadWhitelist()` throws on malformed JSON. If state is corrupted, delete `~/.eliza/whitelist.json` (or `$ELIZA_STATE_DIR/whitelist.json`) and re-verify affected addresses.

### Recovery Procedures

1. **Stuck on-chain transaction:** Check the pending transaction on a block explorer. If stuck, the agent retries with higher gas on next attempt. Manual speed-up via wallet is safe — the agent re-reads nonce on next call.
2. **Corrupted whitelist state:** Delete `~/.eliza/whitelist.json` (or `$ELIZA_STATE_DIR/whitelist.json`) and restart the agent. Re-verify affected addresses via the whitelist verification endpoint.
3. **FxTwitter outage:** Tweet verification is unavailable while the API is down. Monitor `api.fxtwitter.com` status and retry once restored. There is no local fallback.

### Verification Commands

```bash
# Drop service and registry route tests
bunx vitest run src/api/registry-routes.test.ts src/api/drop-service.test.ts src/api/tx-service.test.ts

# Twitter verification unit tests
bunx vitest run src/api/twitter-verify.test.ts

bun run typecheck
```
