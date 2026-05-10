# Wallet SIWE API Key Setup

This runbook covers how an operator can mint an Eliza Cloud API key from a
wallet without exposing the private key to task workers or chat transcripts.

## Current Public Surface

Eliza Cloud has an EVM SIWE bootstrap flow:

- `GET /api/auth/siwe/nonce?chainId=1`
- `POST /api/auth/siwe/verify`

The nonce response returns `nonce`, `domain`, `uri`, `chainId`, `version`, and
`statement`. The verify request accepts:

```json
{
  "message": "EIP-4361 SIWE message",
  "signature": "0x..."
}
```

On success, verify finds or creates the wallet user and organization, deactivates
older API keys named `SIWE sign-in`, and returns a new API key in `apiKey`.

For per-request wallet auth, authenticated Cloud routes also support:

- `X-Wallet-Address`
- `X-Timestamp`
- `X-Wallet-Signature`

The signed message is:

```text
Eliza Cloud Authentication
Timestamp: <timestamp_ms>
Method: <HTTP method>
Path: <request pathname>
```

This is EVM wallet auth. Solana payments are supported by x402/payment routes,
but Solana sign-in is not part of this SIWE route.

## Secure Local Bootstrap

Do not paste a private key into chat, shell history, logs, or committed files.
Load it from a local secret manager into `ELIZA_CLOUD_WALLET_PRIVATE_KEY`, then
run:

```bash
node scripts/cloud-siwe-login.mjs \
  --base-url https://api.elizacloud.ai \
  --chain-id 1
```

The script prints:

```bash
ELIZAOS_CLOUD_API_KEY=<new_key>
```

For a JSON response, use `--json`. For an alternate output variable name, use
`--env-name`.

Workers and spawned agents should receive only `ELIZAOS_CLOUD_API_KEY`, never
the wallet private key. The parent Eliza runtime should keep the key in its
environment or secret store and expose Cloud actions through `parent-agent`
commands.

## Required Local Secrets

For Cloud command workers:

- `ELIZAOS_CLOUD_API_KEY` or `ELIZA_CLOUD_API_KEY`
- Optional `ELIZA_CLOUD_API_BASE_URL` for non-production Cloud API targets

For SIWE bootstrap:

- `ELIZA_CLOUD_WALLET_PRIVATE_KEY` or `ELIZAOS_CLOUD_WALLET_PRIVATE_KEY`

For live payment tests:

- EVM funding wallet secret stored outside chat and shell history
- Solana funding wallet secret stored outside chat and shell history
- chain RPC/facilitator/provider credentials required by the payment route

## Live Test Checklist

1. Confirm the API target: `curl https://api.elizacloud.ai/api/health`.
2. Mint an API key through SIWE with `scripts/cloud-siwe-login.mjs`.
3. Export only `ELIZAOS_CLOUD_API_KEY` for parent-agent and test workers.
4. Create a low-value x402 request with `POST /api/v1/x402/requests`.
5. Settle using a controlled wallet flow, then verify status with
   `GET /api/v1/x402/requests/{id}`.
6. Create a redemption quote and request only after confirming creator earnings
   exist in `GET /api/v1/redemptions/balance`.
7. Record transaction IDs and provider responses, but redact API keys, private
   keys, payment payloads, and signatures.

## Gaps Before Fully Autonomous Funding

- No worker should be handed a private key. A secure signer service or wallet
  connector is required for autonomous live funding.
- Solana sign-in is not implemented in the SIWE routes.
- API key management routes require session auth for key creation; the SIWE
  verify route is the deterministic bootstrap path.
- Live bridge/funding across Base, Ethereum, BSC, and Solana requires configured
  providers, chain-specific gas checks, and a controlled budget window.
