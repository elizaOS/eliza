# @elizaos/plugin-robinhood

Cheshire Terminal **Robinhood Chain** forge plugin for elizaOS.

## Actions

| Action | Description |
| --- | --- |
| `REGISTER_ROBINHOOD_AGENT` | Preview ERC-8004 identity registration intent (unsigned) |

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `ROBINHOOD_RPC_URL` | recommended | RH chain RPC |
| `ROBINHOOD_CHAIN_ID` | no | default `4663` |
| `CHESHIRE_IDENTITY_REGISTRY` | for ready forge | ERC-8004 identity |
| `CHESHIRE_REPUTATION_REGISTRY` | optional | reputation |
| `CHESHIRE_VALIDATION_REGISTRY` | optional | validation |
| `ROBINHOOD_LIVE` | no | default off — preview only |
| `CHESHIRE_API_URL` | no | default `https://cheshireterminal.ai` |

Private keys are **never** accepted by this plugin. Live txs must be signed by the operator wallet outside the agent process.

## Character usage

```ts
plugins: [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-bootstrap",
  "@elizaos/plugin-robinhood",
]
```
