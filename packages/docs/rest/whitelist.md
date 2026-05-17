---
title: Whitelist API
sidebarTitle: Whitelist
description: REST API endpoints for whitelist status, Twitter verification, and Merkle proof generation.
---

## Whitelist Status

```
GET /api/whitelist/status
```

Returns the current whitelist status for the agent.

**Response:**
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
| `twitterVerified` | boolean | Whether the Twitter verification step is complete |
| `ogCode` | string\|null | OG verification code, if any |
| `walletAddress` | string | The wallet address being checked |

## Twitter Verification

### Get Verification Message

```
POST /api/whitelist/twitter/message
```

Generates a verification message for the user to post on Twitter.

### Verify Twitter Post

```
POST /api/whitelist/twitter/verify
```

Verifies that the user posted the verification message on Twitter and, if verified, adds them to the whitelist.

## Merkle Proofs

### Get Merkle Root

```
GET /api/whitelist/merkle/root
```

Returns the Merkle root hash and address count for the current in-memory whitelist tree.

**Response:**
```json
{
  "root": "0xdeadbeef...",
  "addressCount": 1847,
  "proofReady": true
}
```

### Get Merkle Proof

```
GET /api/whitelist/merkle/proof
```

Generates the Merkle inclusion proof for a given wallet address. The proof can be passed directly to the `mintWhitelist()` on-chain function.

**Query params:**

| Param | Type | Required |
|-------|------|----------|
| `address` | string | yes |

**Response:**
```json
{
  "proof": ["0xabc...", "0xdef..."],
  "leaf": "0x123...",
  "root": "0xdeadbeef...",
  "isWhitelisted": true
}
```

`proof` is an empty array and `isWhitelisted` is `false` if the address is not in the tree.

**Errors:** `400` if `address` query param is missing.
