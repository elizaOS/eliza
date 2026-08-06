# CLAWD Agent Product Package

This package turns the CLAWD.md concept into a deployable Metaplex/ERC-8004 agent registration plus a working Solana auth/SSO verification flow.

## Files

- `clawd-registration.json` — production-ready ERC-8004 registration document for the CLAWD core auth agent.
- `clawd-core-asset-metadata.json` — MPL Core asset metadata for the CLAWD agent NFT.
- `solana-satoshi-agent.json` — optional Solana Satoshi agent powered by `$CLAWD`.
- `scripts/upload-metadata.ts` — uploads a JSON file to Irys/Arweave and prints the URI.
- `scripts/mint-register-clawd-agent.ts` — creates an MPL Core collection, mints the CLAWD asset, registers the AgentIdentity, registers an executive profile, and delegates execution.
- `scripts/verify-clawd-sso.ts` — verifies wallet signature, `$CLAWD` balance, ownership of a registered agent asset, and emits a short-lived SSO token.
- `scripts/clawd-auth-sso-server.ts` — minimal HTTP API exposing `/api/auth/challenge`, `/api/auth/verify`, and `/.well-known/agent.json`.

## Install

```bash
pnpm install
cp .env.example .env
```

Set `WALLET_SECRET_KEY` in `.env` to a funded Solana keypair. Use a deployment secret manager; do not commit it.

## Upload registration JSON

```bash
pnpm upload:metadata clawd-registration.json
```

Copy the printed URI into `.env` as `REGISTRATION_URI`.

## Mint + register CLAWD agent

```bash
pnpm mint:register
```

The script writes `clawd-mint-result.json` with:

- `asset`
- `collection`
- `agentIdentityPda`
- `executiveProfilePda`
- `assetSignerPda`

Replace `<CLAWD_AGENT_ASSET_PUBLIC_KEY>` and related placeholders in `clawd-registration.json` once you have those values, then upload the final JSON again.

## Run auth/SSO verifier

```bash
pnpm api
```

Challenge:

```bash
curl -X POST http://localhost:8787/api/auth/challenge \
  -H 'content-type: application/json' \
  -d '{"wallet":"<WALLET>","agentAsset":"<AGENT_ASSET>"}'
```

The wallet signs the returned `message`.

Verify:

```bash
curl -X POST http://localhost:8787/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{"wallet":"<WALLET>","agentAsset":"<AGENT_ASSET>","nonce":"<NONCE>","message":"<MESSAGE>","signature":"<BASE58_SIGNATURE>"}'
```

A successful response returns a `CLAWD_AUTH_V1` session token.

## Auth rule

A wallet qualifies for CLAWD SSO when:

1. It signs the challenge.
2. It holds at least `MIN_CLAWD_UI_AMOUNT` of `$CLAWD`.
3. It owns the submitted MPL Core agent asset.
4. That asset has a Metaplex AgentIdentity registration.

`$CLAWD` mint used in this package:

```text
8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump
```

## Production notes

- Put the auth server behind your x402 middleware so paid actions can require HTTP 402 settlement before tool execution.
- Do not store private keys in repo files.
- Keep `Mayhem Mode` limited to authorized simulations, staging, chaos drills, and auditable DAO operations. The JSON encodes this as guarded chaos engineering, not unrestricted behavior.
- `x402.wtf/agents` and `/api` may be Clerk-protected for browser access. Server-to-server calls should use your platform/internal auth.
