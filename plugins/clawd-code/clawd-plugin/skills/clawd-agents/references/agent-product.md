# CLAWD Agent Product Reference

Source: `/Users/8bit/clawd-code/clawd-agents/clawd-agent-product`

This package turns a CLAWD agent concept into a deployable Solana agent product: registration metadata, MPL Core asset metadata, mint/register scripts, and a token-gated SSO verifier.

## Files

| File | Purpose |
|---|---|
| `clawd-registration.json` | Agent registration document for the CLAWD core auth agent |
| `clawd-core-asset-metadata.json` | MPL Core asset metadata for the CLAWD agent NFT |
| `solana-satoshi-agent.json` | Optional `$CLAWD` powered Solana Satoshi agent profile |
| `scripts/upload-metadata.ts` | Uploads JSON metadata and prints the URI |
| `scripts/mint-register-clawd-agent.ts` | Creates collection, mints asset, registers identity/profile, and delegates execution |
| `scripts/verify-clawd-sso.ts` | Verifies wallet signature, `$CLAWD` balance, agent ownership, and registration |
| `scripts/clawd-auth-sso-server.ts` | HTTP API for challenge, verification, and well-known agent metadata |

## Environment

Use `.env.example` as the contract:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Solana RPC endpoint, Helius recommended |
| `WALLET_SECRET_KEY` | Dedicated funded Solana keypair; never commit it |
| `REGISTRATION_URI` | URI printed by the metadata upload script |
| `COLLECTION_URI` | Optional collection metadata URI |
| `ASSET_URI` | Optional agent asset metadata URI |
| `CLAWD_MINT` | `$CLAWD` mint, currently `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump` |
| `MIN_CLAWD_UI_AMOUNT` | Minimum token balance required for SSO |
| `SESSION_TTL_SECONDS` | Session token lifetime |
| `SESSION_SECRET` | Server-side signing secret |
| `PORT` | Local auth server port |

## Build Flow

1. Install package dependencies with the repo's package manager.
2. Copy `.env.example` to `.env` and fill secrets outside git.
3. Upload `clawd-registration.json`; persist the resulting URI as `REGISTRATION_URI`.
4. Run the mint/register script with a funded wallet.
5. Capture `asset`, `collection`, `agentIdentityPda`, `executiveProfilePda`, and `assetSignerPda`.
6. Replace registration placeholders with the actual asset and PDA values.
7. Upload the final registration JSON again.
8. Run the auth/SSO server.

## SSO Contract

A wallet qualifies for CLAWD SSO only when all checks pass:

- The wallet signs the issued challenge.
- The wallet holds at least `MIN_CLAWD_UI_AMOUNT` of `$CLAWD`.
- The wallet owns the submitted MPL Core agent asset.
- The submitted asset has a registered Metaplex AgentIdentity.

Successful verification returns a short-lived `CLAWD_AUTH_V1` session token.

## Production Rules

- Put the auth server behind the x402 middleware when paid actions should require settlement before execution.
- Keep wallet keys and session secrets in a deployment secret manager.
- Treat SSO tokens and JWTs as credentials; never print full values in logs.
- Keep high-risk modes limited to authorized simulations, staging, chaos drills, or auditable DAO operations.
- Prefer server-to-server auth for protected `x402.wtf/agents` or API calls.

## Related Skills

- `../agent-arena/SKILL.md` for Metaplex Core identity, hosted A2A/MCP cards, discovery, hiring, and reviews.
- `x402.md` for payment-gated access and paid A2A/MCP routing.
