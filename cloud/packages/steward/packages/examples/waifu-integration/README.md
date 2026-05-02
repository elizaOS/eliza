# waifu.fun Steward integration example

This example shows how a platform such as `waifu.fun` can use Steward as the wallet backend for an agent character. It covers tenant registration, agent wallet creation, policy setup, a webhook receiver for approval notifications, and a three-step transaction lifecycle:

- Small transaction: auto-approved by policy
- Medium transaction: queued for manual approval and then approved by the platform
- Large transaction: rejected by policy before signing

## What This Demonstrates

- Registering a multi-tenant platform with Steward
- Authenticating with `X-Steward-Tenant` and `X-Steward-Key`
- Creating a wallet for a new waifu character (`milady-trader`)
- Applying default guardrails:
  - `spending-limit`: `0.1 ETH` per tx, `1 ETH` per day
  - `approved-addresses`: Uniswap Universal Router on Base, Base USDC, and the demo wallet itself for an executable self-transfer path
  - `auto-approve-threshold`: `0.01 ETH`
- Handling an approval-required webhook on the platform side
- Approving a queued transaction through Steward after the webhook arrives

## Prerequisites

- A running Steward API
- A reachable Postgres instance for the API
- Bun installed locally
- For the full transaction demo:
  - Steward API configured with a working Base RPC endpoint
  - The generated demo wallet funded with ETH on Base to pay gas

Without wallet funding, the small auto-approved transaction will pass policy but fail during broadcast. The medium and large policy paths still demonstrate the approval and rejection flow.

## Environment Variables

The example uses these defaults, but you can override them:

```bash
export STEWARD_API_URL=http://127.0.0.1:3200
export STEWARD_TENANT_ID=waifu-fun
export STEWARD_API_KEY=waifu-demo-secret
export STEWARD_TENANT_NAME=waifu.fun
export WAIFU_WEBHOOK_PORT=4210
export WAIFU_WEBHOOK_SECRET=waifu-webhook-secret
export WAIFU_AGENT_ID=milady-trader
export WAIFU_AGENT_NAME="Milady Trader"
export WAIFU_PLATFORM_ID=waifu.fun:milady-trader
```

## How To Run

1. Start the Steward API in another shell.
2. Install workspace dependencies:

```bash
bun install
```

3. Run the example:

```bash
bun run --filter @stwd/example-waifu-integration start
```

You should see console output for tenant registration, wallet creation, policy installation, webhook delivery, medium-tx approval, and the final transaction history.

## Notes About The Current API

- Tenant creation in the current API requires `id` and `apiKeyHash` in addition to `name` and `webhookUrl`.
- Pending approval responses from `StewardClient.signTransaction()` do not currently expose `txId`, so the example fetches `/vault/:agentId/pending` to locate the queued transaction before approving it.
- The API has webhook configuration endpoints, but it does not yet dispatch webhook events by itself. This example simulates the `approval_required` delivery using the documented Steward webhook headers so platform integrators can build the receiver now.

## Adapting This For Your Platform

- Replace the tenant defaults with your own platform slug, secret management, and public webhook URL.
- Swap the demo `milady-trader` agent metadata for your own agent/user identifiers.
- Replace the self-transfer demo destination with your real allowlisted contracts and calldata.
- Extend the webhook handler to create an approval task in your own UI, queue, or moderation workflow.
- Call Steward’s approve or reject endpoints from your backend once a human or rules engine has decided.
