---
title: "Wallet & Crypto"
sidebarTitle: "Wallet & Crypto"
description: "Built-in EVM and Solana wallet with key generation, balance fetching, NFT queries, signing policy, and smart contract interactions."
---

Eliza includes a built-in crypto wallet supporting both EVM-compatible chains and Solana. The wallet uses Node.js crypto primitives (no heavy dependencies like viem or @solana/web3.js) and fetches on-chain data via Alchemy (EVM) and Helius (Solana) REST APIs.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Key Generation and Derivation](#key-generation-and-derivation)
3. [Supported Chains and Networks](#supported-chains-and-networks)
4. [Wallet Addresses and Balances](#wallet-addresses-and-balances)
5. [NFT Queries](#nft-queries)
6. [Wallet Import and Export](#wallet-import-and-export)
7. [Key Generation via API](#key-generation-via-api)
8. [Signing Policy](#signing-policy)
9. [Remote Signing Service](#remote-signing-service)
10. [Smart Contract Interactions](#smart-contract-interactions)
11. [Security Model](#security-model)
12. [API Endpoints](#api-endpoints)
13. [Configuration](#configuration)
14. [Environment Variables](#environment-variables)
15. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The Eliza wallet is a self-contained module that runs entirely within the Eliza process. It does not depend on external wallet libraries such as viem or `@solana/web3.js`. Instead, it uses:

- **Node.js `crypto` module** for random byte generation and Ed25519 key derivation.
- **`@noble/curves` (secp256k1)** for EVM public key derivation. This library was chosen because it works across Node, Bun, and browser runtimes. Node's built-in `crypto.createECDH("secp256k1")` fails in Bun due to BoringSSL limitations.
- **A built-in keccak-256 sponge implementation** for Ethereum address derivation and EIP-55 checksumming, avoiding a dependency on external hashing libraries.
- **Built-in Base58 encoder/decoder** using the Bitcoin alphabet for Solana key serialization.

The wallet communicates with blockchain networks exclusively through provider REST APIs (Alchemy for EVM, Helius for Solana). All RPC calls use a 15-second timeout (`AbortSignal.timeout(15_000)`) to prevent hanging requests.

Private keys are stored in `process.env` at runtime and persisted to the agent's `eliza.json` config file (written with `0o600` file permissions for owner-only read/write access).

---

## Key Generation and Derivation

### EVM (secp256k1)

EVM private keys are 32 random bytes generated via `crypto.randomBytes(32)`. The public key is derived using the `@noble/curves` secp256k1 implementation. The uncompressed public key (65 bytes, starting with `0x04`) has its prefix byte stripped, and the remaining 64 bytes are hashed with keccak-256. The Ethereum address is the last 20 bytes of that hash, formatted with EIP-55 checksum encoding.

The checksum encoding works by hashing the lowercase hex address with keccak-256, then uppercasing each hex character whose corresponding nibble in the hash is 8 or higher.

### Solana (Ed25519)

Solana keypairs are generated via `crypto.generateKeyPairSync("ed25519")`. The private key is exported as PKCS8 DER (32-byte seed extracted at offset 16), and the public key as SPKI DER (32-byte raw key at offset 12). The Solana secret key format is seed(32) + pubkey(32), both Base58-encoded using the Bitcoin alphabet.

When deriving a Solana address from a private key:

- **64-byte keys**: The last 32 bytes are the public key, which is Base58-encoded directly.
- **32-byte keys**: The seed is wrapped in a PKCS8 DER envelope, a public key is derived from it, and the 32-byte raw public key is Base58-encoded.

### Combined Key Generation

The `generateWalletKeys()` function produces both an EVM and a Solana keypair at once, returning:

```typescript
interface WalletKeys {
  evmPrivateKey: string;    // 0x-prefixed hex
  evmAddress: string;       // EIP-55 checksummed
  solanaPrivateKey: string;  // Base58-encoded
  solanaAddress: string;     // Base58-encoded public key
}
```

You can also generate for a single chain with `generateWalletForChain("evm" | "solana")`, which returns:

```typescript
interface WalletGenerateResult {
  chain: "evm" | "solana";
  address: string;
  privateKey: string;
}
```

---

## Supported Chains and Networks

### EVM Chains

Eliza supports five EVM chains out of the box, all fetched via Alchemy:

| Chain | Chain ID | Native Symbol | Alchemy Subdomain |
|-------|----------|---------------|-------------------|
| Ethereum | 1 | ETH | eth-mainnet |
| Base | 8453 | ETH | base-mainnet |
| Arbitrum | 42161 | ETH | arb-mainnet |
| Optimism | 10 | ETH | opt-mainnet |
| Polygon | 137 | POL | polygon-mainnet |

Balance queries run in parallel across all chains via `eth_getBalance` (native) and `alchemy_getTokenBalances` (ERC-20 tokens). Token metadata is resolved with `alchemy_getTokenMetadata`, limited to the first 50 non-zero-balance tokens per chain.

Each chain balance response includes:

```typescript
interface EvmChainBalance {
  chain: string;        // e.g. "Ethereum"
  chainId: number;      // e.g. 1
  nativeBalance: string;
  nativeSymbol: string; // e.g. "ETH"
  nativeValueUsd: string;
  tokens: EvmTokenBalance[];
  error: string | null;
}
```

If a chain query fails, its `error` field is populated while other chains continue returning results.

### Solana

Solana balances are fetched via Helius RPC (`mainnet.helius-rpc.com`):

- **SOL balance**: Standard `getBalance` RPC call, divided by 1e9 for display.
- **SPL tokens**: `getAssetsByOwner` with `showFungible: true`, extracting `FungibleToken` and `FungibleAsset` interfaces. Returns up to 100 tokens with symbol, name, mint address, balance, decimals, and USD value (if available from Helius price data).

The Solana token response structure:

```typescript
interface SolanaTokenBalance {
  symbol: string;
  name: string;
  mint: string;       // SPL token mint address
  balance: string;
  decimals: number;
  valueUsd: string;
  logoUrl: string;
}
```

---

## Wallet Addresses and Balances

The `getWalletAddresses()` function derives addresses from environment variables `EVM_PRIVATE_KEY` and `SOLANA_PRIVATE_KEY` without requiring a running runtime. If a key is set but invalid, the corresponding address is `null` and a warning is logged. Returns:

```typescript
interface WalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}
```

The full balance response combines EVM and Solana data:

```typescript
interface WalletBalancesResponse {
  evm: {
    address: string;
    chains: EvmChainBalance[];
  } | null;
  solana: {
    address: string;
    solBalance: string;
    solValueUsd: string;
    tokens: SolanaTokenBalance[];
  } | null;
}
```

Fields are `null` when the corresponding private key or provider API key is not configured.

---

## NFT Queries

### EVM NFTs

Fetched via Alchemy NFT v3 API (`getNFTsForOwner`) across all supported chains. Returns up to 50 NFTs per chain with metadata:

```typescript
interface EvmNft {
  contractAddress: string;
  tokenId: string;
  name: string;
  description: string;  // truncated to 200 characters
  imageUrl: string;      // cached URL preferred, then thumbnail, then original
  collectionName: string;
  tokenType: string;     // e.g. "ERC721"
}
```

### Solana NFTs

Fetched via Helius `getAssetsByOwner` filtering for `V1_NFT`, `ProgrammableNFT`, and `V2_NFT` interfaces. Returns up to 100 NFTs:

```typescript
interface SolanaNft {
  mint: string;
  name: string;
  description: string;  // truncated to 200 characters
  imageUrl: string;
  collectionName: string;
}
```

The combined response groups EVM NFTs by chain:

```typescript
interface WalletNftsResponse {
  evm: Array<{ chain: string; nfts: EvmNft[] }>;
  solana: { nfts: SolanaNft[] } | null;
}
```

---

## Wallet Import and Export

### Import

The `POST /api/wallet/import` endpoint accepts a `chain` ("evm" or "solana") and `privateKey`. If no chain is specified, the key format is auto-detected:

- Keys starting with `0x` or 64-character hex strings are treated as EVM.
- All other keys are treated as Solana (Base58-decoded, validated as 32 or 64 bytes).

On successful import, the key is stored in `process.env` and persisted to the agent's `eliza.json` config file under the `env` section. The import function validates the key, derives the address, and returns:

```typescript
interface WalletImportResult {
  success: boolean;
  chain: "evm" | "solana";
  address: string | null;
  error: string | null;
}
```

### Export (Private Key Export)

The `POST /api/wallet/export` endpoint returns private keys for both chains. This endpoint is protected by a rejection resolver that checks for valid auth tokens and explicit confirmation. Key exports are logged as warnings. The response contains:

```json
{
  "evm": { "privateKey": "0x...", "address": "0x..." },
  "solana": { "privateKey": "Base58...", "address": "Base58..." }
}
```

Either field is `null` if the corresponding key is not configured.

### Key Validation

Keys are validated before import. The validation returns a structured result:

```typescript
interface KeyValidationResult {
  valid: boolean;
  chain: "evm" | "solana";
  address: string | null;
  error: string | null;
}
```

Validation rules:

- **EVM**: Must be exactly 64 hex characters (with or without `0x` prefix). Address derivation is verified by running the full secp256k1 public key derivation and keccak-256 hash.
- **Solana**: Must decode from Base58 to exactly 32 or 64 bytes. Address derivation is verified by extracting or deriving the public key.

### Secret Masking

When private keys appear in logs or UI, the `maskSecret()` utility shows only the first 4 and last 4 characters (e.g., `0x1a...9f3b`). Keys shorter than 8 characters are replaced entirely with `****`.

---

## Key Generation via API

The `POST /api/wallet/generate` endpoint creates fresh wallets. It accepts a `chain` parameter:

- `"evm"` — generate only an EVM wallet
- `"solana"` — generate only a Solana wallet
- `"both"` (default) — generate both

Generated keys are immediately stored in `process.env` and persisted to the config file. The response:

```json
{
  "ok": true,
  "wallets": [
    { "chain": "evm", "address": "0x..." },
    { "chain": "solana", "address": "Base58..." }
  ]
}
```

<Warning>
Generating a new wallet overwrites any existing private key for that chain. The previous key is not backed up. Export your keys before generating new ones.
</Warning>

---

## Signing Policy

The signing policy engine evaluates transaction requests against configurable rules before allowing signatures. It runs entirely in-memory and is instantiated per agent.

### Policy Configuration

```typescript
interface SigningPolicy {
  allowedChainIds: number[];          // empty = allow all
  allowedContracts: string[];         // lowercase addresses; empty = allow all
  deniedContracts: string[];          // checked before allowlist
  maxTransactionValueWei: string;     // default: "100000000000000000" (0.1 ETH)
  maxTransactionsPerHour: number;     // default: 10
  maxTransactionsPerDay: number;      // default: 50
  allowedMethodSelectors: string[];   // 4-byte hex; empty = allow all
  humanConfirmationThresholdWei: string; // default: "10000000000000000" (0.01 ETH)
  requireHumanConfirmation: boolean;
}
```

### Default Policy Values

When no custom policy is specified, these defaults apply:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxTransactionValueWei` | `100000000000000000` | 0.1 ETH maximum per transaction |
| `maxTransactionsPerHour` | `10` | Hourly rate limit |
| `maxTransactionsPerDay` | `50` | Daily rate limit |
| `humanConfirmationThresholdWei` | `10000000000000000` | 0.01 ETH triggers human confirmation |
| `requireHumanConfirmation` | `false` | When true, all transactions require confirmation |

### Evaluation Order

The policy evaluator checks rules in a strict order. The first failing check short-circuits the evaluation:

1. **Replay protection** — Reject if the `requestId` was already processed.
2. **Chain ID allowlist** — Reject if `allowedChainIds` is non-empty and the chain is not listed.
3. **Contract denylist** — Reject if the target address appears in `deniedContracts` (case-insensitive).
4. **Contract allowlist** — Reject if `allowedContracts` is non-empty and the target is not listed (case-insensitive).
5. **Value cap** — Reject if the transaction value exceeds `maxTransactionValueWei`.
6. **Method selector allowlist** — Reject if `allowedMethodSelectors` is non-empty and the first 4 bytes of calldata (`data[0:10]`) are not listed.
7. **Hourly rate limit** — Reject if the count of requests in the last hour reaches `maxTransactionsPerHour`.
8. **Daily rate limit** — Reject if the count of requests in the last 24 hours reaches `maxTransactionsPerDay`.
9. **Human confirmation** — If `requireHumanConfirmation` is true, or the value exceeds `humanConfirmationThresholdWei`, mark the decision as requiring human approval.

### Policy Decisions

Each signing request is evaluated and returns:

```typescript
type PolicyDecision = {
  allowed: boolean;
  reason: string;
  requiresHumanConfirmation: boolean;
  matchedRule: string;
};
```

The `matchedRule` field indicates which check caused the decision: `replay_protection`, `chain_id_allowlist`, `contract_denylist`, `contract_allowlist`, `value_cap`, `method_selector_allowlist`, `rate_limit_hourly`, `rate_limit_daily`, `value_parse_error`, or `allowed`.

### Replay Protection and Rate Limiting

The evaluator maintains:

- A **request log** with `{ requestId, timestamp }` entries, pruned to the last 24 hours of data on each evaluation.
- A **processed-request-ID set** capped at 10,000 entries. When the cap is reached, the oldest 5,000 entries are removed.

After a transaction is successfully signed, `recordRequest(requestId)` must be called to update both the replay set and the rate-limiting log.

---

## Remote Signing Service

The remote signing service sits between sandboxed agent code and the wallet's private keys. Private keys never leave the host process; sandboxed agents submit unsigned transactions that pass through policy checks before being signed.

### Flow

1. The agent submits a `SigningRequest` containing chain ID, target address, value, calldata, and optional gas parameters.
2. The `RemoteSigningService` evaluates the request against the signing policy.
3. If the policy allows the transaction **without** human confirmation, the service signs it immediately and returns the signed transaction.
4. If human confirmation is required, the request is queued as a `PendingApproval` with a configurable timeout (default: 5 minutes).
5. A human operator can then approve or reject the pending request.
6. Approved requests are signed and returned. Expired or rejected requests fail.

### Signing Request Structure

```typescript
interface SigningRequest {
  requestId: string;
  chainId: number;
  to: string;
  value: string;
  data: string;
  nonce?: number;
  gasLimit?: string;
  createdAt: number;
}
```

### Signing Result

```typescript
interface SigningResult {
  success: boolean;
  signature?: string;      // signed transaction hex
  error?: string;
  policyDecision: PolicyDecision;
  humanConfirmed: boolean;
}
```

### Pending Approvals

Pending approvals are stored in memory with an expiration timestamp. The service exposes:

- `getPendingApprovals()` — returns all non-expired pending approvals.
- `approveRequest(requestId)` — signs and returns the transaction.
- `rejectRequest(requestId)` — removes the pending approval.

### Audit Logging

All signing events are recorded to a `SandboxAuditLog` (if configured). Event types include:

- `signing_request_submitted` — logged when a request is received, with chain, target, value, and policy decision.
- `signing_request_rejected` — logged when a request fails policy or is explicitly rejected.
- `signing_request_approved` — logged when a transaction is signed, including whether human confirmation was obtained.
- `policy_decision` — logged when the signing policy is updated.

---

## Smart Contract Interactions

Eliza defines several smart contract interaction interfaces in `src/contracts/`:

### Apps Registry (`src/contracts/apps.ts`)

Manages installable apps with viewer configurations:

- `AppLaunchResult` — plugin installation, display name, launch URL, viewer config
- `InstalledAppInfo` — installed app metadata (name, plugin, version, install time)
- `AppStopResult` — app shutdown with plugin uninstall scope

### Drops and Airdrops (`src/contracts/drop.ts`)

Supports NFT minting with drop mechanics:

- `DropStatus` — drop state (dropEnabled, publicMintOpen, whitelistMintOpen, mintedOut, currentSupply, maxSupply, shinyPrice, userHasMinted)
- `MintResult` — agentId (number), mintNumber, txHash, isShiny

### Verification (`src/contracts/verification.ts`)

Identity verification:

- `VerificationResult` — verified boolean, error message, handle

---

## Security Model

### Key Storage

Private keys are stored in two places:

1. **Runtime memory** — `process.env.EVM_PRIVATE_KEY` and `process.env.SOLANA_PRIVATE_KEY` are set when keys are generated or imported.
2. **Config file** — the `env` section of `eliza.json` persists keys to disk. The config file is written with `0o600` permissions (owner read/write only) and the config directory is created with `0o700` permissions.

**Planned:** optional storage in the OS secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service) with a **per-state-directory vault id**, so keys are not persisted in plaintext config when enabled. See [Platform secure store (design)](/guides/platform-secure-store).

### Key Isolation for Sandboxed Agents

Private keys stay on the host process. Sandboxed agent code never has direct access to key material. Instead, agents submit unsigned transactions to the `RemoteSigningService`, which:

- Evaluates the transaction against the signing policy.
- Signs the transaction using a `SignerBackend` that holds the actual keys.
- Returns only the signed transaction (not the key).

### Wallet Export Protection

The `POST /api/wallet/export` endpoint (which returns raw private keys) is protected by:

1. A `resolveWalletExportRejection` function that checks the request for valid auth tokens and explicit confirmation.
2. All export events are logged as warnings.

### Audit Trail

The `SandboxAuditLog` records all security-relevant wallet events. The audit log is append-only, capped at 5,000 entries per instance. Entries include timestamps, event types, human-readable summaries, structured metadata, and severity levels (`info`, `warn`, `error`, `critical`).

A process-wide audit feed aggregates entries from all `SandboxAuditLog` instances, supporting real-time subscribers and historical queries by event type, severity, or time range.

---

## API Endpoints

### Wallet Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/wallet/addresses` | Get current EVM and Solana addresses |
| `GET` | `/api/wallet/balances` | Fetch balances across all chains |
| `GET` | `/api/wallet/nfts` | Fetch NFTs across all chains |
| `GET` | `/api/wallet/config` | Get wallet configuration status (which API keys are set, supported chains, addresses) |
| `PUT` | `/api/wallet/config` | Update wallet API keys (Alchemy, Infura, Ankr, Helius, Birdeye) |
| `POST` | `/api/wallet/import` | Import a private key (auto-detects chain) |
| `POST` | `/api/wallet/generate` | Generate new wallet(s) for "evm", "solana", or "both" |
| `POST` | `/api/wallet/export` | Export private keys (requires confirmation) |

### Configuration Status Response

The `GET /api/wallet/config` response indicates which provider API keys are set:

```json
{
  "alchemyKeySet": true,
  "infuraKeySet": false,
  "ankrKeySet": false,
  "heliusKeySet": true,
  "birdeyeKeySet": false,
  "evmChains": ["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon"],
  "evmAddress": "0x...",
  "solanaAddress": "..."
}
```

### Updating API Keys

The `PUT /api/wallet/config` endpoint accepts a JSON body with any combination of provider keys:

```json
{
  "ALCHEMY_API_KEY": "your-key",
  "HELIUS_API_KEY": "your-key"
}
```

Only these keys are accepted: `ALCHEMY_API_KEY`, `INFURA_API_KEY`, `ANKR_API_KEY`, `HELIUS_API_KEY`, `BIRDEYE_API_KEY`. Any other fields in the body are ignored.

When `HELIUS_API_KEY` is set, the service also automatically configures `SOLANA_RPC_URL` to `https://mainnet.helius-rpc.com/?api-key=<key>`.

After updating, the service calls `ensureWalletKeysInEnvAndConfig` to verify keys are consistent, saves the config to disk, and optionally schedules a runtime restart.

---

## Configuration

### Config File Location

Wallet configuration lives within the main Eliza config file (`eliza.json`). The config is loaded using JSON5 (supporting comments and trailing commas) and resolved via includes.

Private keys and API keys are stored in the `env` section:

```json5
{
  "env": {
    "EVM_PRIVATE_KEY": "0x...",
    "SOLANA_PRIVATE_KEY": "Base58...",
    "ALCHEMY_API_KEY": "your-alchemy-key",
    "HELIUS_API_KEY": "your-helius-key"
  }
}
```

Environment variables set in the config file are applied to `process.env` at load time, but only if the variable is not already defined. This means shell-level environment variables take precedence over config file values.

### File Permissions

The config file is written with restrictive permissions because it may contain private keys:

- **Config file**: `0o600` (owner read/write only)
- **Config directory**: `0o700` (owner full access only)

---

## Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `EVM_PRIVATE_KEY` | EVM wallet | 0x-prefixed hex private key |
| `SOLANA_PRIVATE_KEY` | Solana wallet | Base58-encoded secret key (32 or 64 bytes) |
| `ALCHEMY_API_KEY` | EVM balances and NFTs | Alchemy API key for all EVM chains |
| `HELIUS_API_KEY` | Solana balances and NFTs | Helius API key for Solana RPC |
| `INFURA_API_KEY` | Alternative EVM provider | Infura project ID |
| `ANKR_API_KEY` | Alternative EVM provider | Ankr API key |
| `BIRDEYE_API_KEY` | Token price data | Birdeye API key for price feeds |
| `SOLANA_RPC_URL` | Solana RPC override | Auto-set when HELIUS_API_KEY is configured |

---

## Troubleshooting

### No balances returned

- Verify that `ALCHEMY_API_KEY` (for EVM) or `HELIUS_API_KEY` (for Solana) is set. Check with `GET /api/wallet/config`.
- The balance endpoints return `null` (not an error) when the API key or private key is missing.
- Each chain query has a 15-second timeout. If a provider is slow, individual chain results may include an `error` field while others succeed.

### Key import fails

- **EVM**: The key must be exactly 64 hex characters, with or without a `0x` prefix. Other formats are rejected.
- **Solana**: The key must Base58-decode to exactly 32 or 64 bytes. Invalid Base58 characters or wrong lengths are rejected.
- If no `chain` is specified, auto-detection assumes any key starting with `0x` or any 64-character hex string is EVM. Everything else is treated as Solana.

### Signing request rejected

- Check the `matchedRule` field in the `PolicyDecision` to identify which policy check failed.
- Common issues: transaction value exceeding `maxTransactionValueWei` (default 0.1 ETH), target contract on the denylist, or hourly/daily rate limits reached.
- Replay-protected requests cannot be resubmitted with the same `requestId`.

### Wallet export returns 401 or 403

- The export endpoint requires explicit confirmation and a valid auth token. Ensure you pass the correct `exportToken` and set `confirm: true` in the request body.

### Config file not saving

- Ensure the config directory exists and is writable. The service creates it with `0o700` permissions if missing.
- Config save failures are logged as warnings but do not fail the API request — keys are still set in `process.env` for the current session.
