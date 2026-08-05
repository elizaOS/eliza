# ZK Compression — Compressed State on Solana

## When To Use

ZK Compression (Light Protocol) stores account state in Merkle trees instead of full Solana accounts, reducing on-chain storage costs by orders of magnitude. Use these tools when working with compressed accounts, compressed tokens, or applications built on the Light Protocol stack.

- Install implementation skills with `npx skills add Lightprotocol/skills`.
- Configure the docs MCP server at `https://www.zkcompression.com/mcp` as `zkcompression`.
- 10 credits per request (all methods)
- Available on ALL plans, including free tier
- All address parameters are base58-encoded
- Paginated endpoints use cursor-based pagination

Use Helius MCP tools for live compressed account queries, proofs, signatures, and indexer health. Use Light Protocol skills for client/program implementation patterns: compressed PDA programs, compressed token operations, nullifiers, validity proofs, and custom ZK apps.

## Choosing the Right Method

| You want to... | Use this method | MCP tool |
|---|---|---|
| Fetch one compressed account | `getCompressedAccount` | `getCompressedAccount` |
| List compressed accounts for a wallet | `getCompressedAccountsByOwner` | `getCompressedAccountsByOwner` |
| Batch-fetch multiple compressed accounts | `getMultipleCompressedAccounts` | `getMultipleCompressedAccounts` |
| Check compressed SOL balance of one account | `getCompressedBalance` | `getCompressedBalance` |
| Check total compressed SOL for a wallet | `getCompressedBalanceByOwner` | `getCompressedBalanceByOwner` |
| List holders of a compressed token | `getCompressedMintTokenHolders` | `getCompressedMintTokenHolders` |
| Check balance of a single compressed token account | `getCompressedTokenAccountBalance` | `getCompressedTokenAccountBalance` |
| List compressed token accounts for a wallet | `getCompressedTokenAccountsByOwner` | `getCompressedTokenAccountsByOwner` |
| List compressed token accounts by delegate | `getCompressedTokenAccountsByDelegate` | `getCompressedTokenAccountsByDelegate` |
| Summarize compressed token balances per mint | `getCompressedTokenBalancesByOwnerV2` | `getCompressedTokenBalancesByOwnerV2` |
| Get Merkle proof for a compressed account | `getCompressedAccountProof` | `getCompressedAccountProof` |
| Batch Merkle proofs | `getMultipleCompressedAccountProofs` | `getMultipleCompressedAccountProofs` |
| Get non-inclusion proofs for new addresses | `getMultipleNewAddressProofsV2` | `getMultipleNewAddressProofs` |
| Get signatures for a compressed account | `getCompressionSignaturesForAccount` | `getCompressionSignaturesForAccount` |
| Get signatures for a compressed address | `getCompressionSignaturesForAddress` | `getCompressionSignaturesForAddress` |
| Get all compression signatures for a wallet | `getCompressionSignaturesForOwner` | `getCompressionSignaturesForOwner` |
| Get token-specific compression signatures | `getCompressionSignaturesForTokenOwner` | `getCompressionSignaturesForTokenOwner` |
| Get latest compression transactions network-wide | `getLatestCompressionSignatures` | `getLatestCompressionSignatures` |
| Get latest non-voting compression transactions | `getLatestNonVotingSignatures` | `getLatestNonVotingSignatures` |
| Inspect compression state changes in a transaction | `getTransactionWithCompressionInfo` | `getTransactionWithCompressionInfo` |
| Generate ZK validity proof for a transaction | `getValidityProof` | `getValidityProof` |
| Check indexer health | `getIndexerHealth` | `getIndexerHealth` |
| Check latest indexed slot | `getIndexerSlot` | `getIndexerSlot` |

## Method Categories

### Account Queries

- **getCompressedAccount** — Fetch a single compressed account by address OR hash. Returns lamports, owner, tree info, and data. At least one of `address` or `hash` is required.
- **getCompressedAccountsByOwner** — Paginated list of all compressed accounts owned by a wallet. Use to discover what compressed state a wallet holds.
- **getMultipleCompressedAccounts** — Batch-fetch up to many compressed accounts by addresses OR hashes in one call. At least one of `addresses` or `hashes` is required.

### Balance Queries

- **getCompressedBalance** — Compressed SOL balance for a single account (by address or hash). Analogous to `getBalance` for regular accounts.
- **getCompressedBalanceByOwner** — Total compressed SOL across all accounts owned by a wallet. Use for portfolio views that include compressed state.

### Token Queries

- **getCompressedMintTokenHolders** — Paginated list of holders and balances for a compressed token mint. Use for token distribution analysis.
- **getCompressedTokenAccountBalance** — Balance of a single compressed token account (by address or hash).
- **getCompressedTokenAccountsByOwner** — All compressed token accounts for a wallet, optionally filtered by mint. Returns token data (mint, amount, delegate, state).
- **getCompressedTokenAccountsByDelegate** — Compressed token accounts delegated to an address, optionally filtered by mint.
- **getCompressedTokenBalancesByOwnerV2** — Aggregated compressed token balances per mint for a wallet. Best for summarizing a wallet's compressed token portfolio. Note: this tool calls `getCompressedTokenBalancesByOwnerV2` under the hood — the V2 suffix is intentional.

### Proof Queries

- **getCompressedAccountProof** — Merkle proof for a compressed account by hash. Required for building transactions that modify compressed state.
- **getMultipleCompressedAccountProofs** — Batch Merkle proofs for multiple accounts. More efficient than individual proof calls.
- **getMultipleNewAddressProofs** — Non-inclusion proofs for new address-tree pairs. Required when creating new compressed accounts. Calls `getMultipleNewAddressProofsV2` under the hood.

### Signature Queries

- **getCompressionSignaturesForAccount** — Transaction signatures for a specific compressed account (by hash).
- **getCompressionSignaturesForAddress** — Transaction signatures for a specific address. Paginated.
- **getCompressionSignaturesForOwner** — All compression transaction signatures for a wallet. Paginated.
- **getCompressionSignaturesForTokenOwner** — Compression signatures specifically for token operations by a wallet. Paginated.
- **getLatestCompressionSignatures** — Most recent compression transactions across the network. Paginated. No address filter — useful for monitoring network-wide compression activity.
- **getLatestNonVotingSignatures** — Most recent non-voting compression transactions. Paginated. Filters out vote transactions for cleaner activity feeds.

### Transaction Inspection

- **getTransactionWithCompressionInfo** — Inspect a transaction's compression state changes: which accounts were opened and closed, including optional token data. Use to verify compression operations.

### Validity Proofs

- **getValidityProof** — Generate a ZK validity proof for compressed account operations. Required for building transactions that modify compressed state. Accepts `hashes` (existing accounts) and/or `newAddressesWithTrees` (new accounts).

### Indexer Health

- **getIndexerHealth** — Check if the ZK Compression indexer is healthy and responsive. Returns a status string.
- **getIndexerSlot** — Latest slot processed by the indexer. Use to monitor indexer lag relative to the network tip.

## Pagination

All paginated endpoints use cursor-based pagination:

1. Make the initial request (optionally with `limit`)
2. If the response includes a `cursor` value, pass it in the next request
3. Continue until no `cursor` is returned or results are empty

Default page size is 20 for all paginated methods.

## Building Compression Transactions

To build a transaction that modifies compressed state:

1. Fetch the compressed account(s) with `getCompressedAccount` or `getCompressedAccountsByOwner`
2. Get Merkle proofs with `getCompressedAccountProof` or `getMultipleCompressedAccountProofs`
3. If creating new accounts, get non-inclusion proofs with `getMultipleNewAddressProofs`
4. Generate a validity proof with `getValidityProof`
5. Build and submit the transaction using the proofs

## Common Mistakes

- Forgetting to provide at least one of `address` or `hash` for single-account lookups — both are optional individually but at least one is required
- Using `getCompressedTokenBalancesByOwner` (without V2) — the correct tool name is `getCompressedTokenBalancesByOwnerV2`
- Not paginating — large result sets require following the cursor; always check for a `cursor` in the response
- Confusing compressed account operations with standard DAS cNFT operations — ZK Compression (Light Protocol) is a different system from Metaplex compressed NFTs. Use `references/das.md` tools for cNFTs and these tools for Light Protocol compressed state
- Skipping validity proofs — any transaction that modifies compressed state requires a validity proof from `getValidityProof`
- Not checking indexer health — if `getIndexerHealth` reports unhealthy or `getIndexerSlot` shows significant lag, queries may return stale data
