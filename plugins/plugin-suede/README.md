# @suedeai/plugin-suede

ElizaOS plugin: **rights-aware music and video generation, payable by AI agents via x402 (USDC on Base mainnet).**

Suede is the agent-native music and media stack. Agents call 17 pay-per-call endpoints on `https://app.suedeai.ai`, pay in USDC on Base via the [x402](https://x402.org) protocol, and receive media artifacts with rights provenance attached.

This plugin is a thin in-tree wrapper around the published npm package [`@suedeai/plugin-suede`](https://www.npmjs.com/package/@suedeai/plugin-suede). The implementation, character JSON, and `SuedeClient` TypeScript helper live in the source-of-truth repository at [github.com/Suede-AI/elizaos-plugin-suede](https://github.com/Suede-AI/elizaos-plugin-suede).

---

## What it does

- **Music generation** via Suede's catalog of model tiers (Cinematic = Sora + Kling, plus other tiers).
- **Video generation** with rights-aware provenance.
- **x402-native billing** — agent wallets pay per call in USDC on Base; no API keys, no Stripe.
- **Discovery via `x402.json`** — endpoint manifest served at `https://app.suedeai.ai/.well-known/x402.json`.

## Install

```bash
npm install @suedeai/plugin-suede
```

Add to `character.json`:

```json
{
  "plugins": ["@suedeai/plugin-suede"],
  "settings": {
    "SUEDE_X402_WALLET_PRIVATE_KEY": "0x...",
    "SUEDE_API_BASE": "https://app.suedeai.ai",
    "SUEDE_MANIFEST_URL": "https://app.suedeai.ai/.well-known/x402.json"
  }
}
```

The wallet must hold USDC on Base mainnet to settle calls.

## Configuration

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `SUEDE_X402_WALLET_PRIVATE_KEY` | recommended | — | EVM private key (hex, 0x-prefixed) that signs x402 payments. Without it, the agent can list endpoints but cannot make paid calls. |
| `SUEDE_API_BASE` | no | `https://app.suedeai.ai` | Override only for staging. |
| `SUEDE_MANIFEST_URL` | no | `https://app.suedeai.ai/.well-known/x402.json` | x402 manifest URL for endpoint discovery. |

## Endpoints

17 pay-per-call endpoints live on `app.suedeai.ai`. The current manifest is the canonical list — fetch `https://app.suedeai.ai/.well-known/x402.json` for prices, capabilities, and ACP packet metadata.

## Links

- npm: https://www.npmjs.com/package/@suedeai/plugin-suede
- Source: https://github.com/Suede-AI/elizaos-plugin-suede
- Suede home: https://suedeai.ai
- x402 manifest: https://app.suedeai.ai/.well-known/x402.json
- Contact: johnnysuedes@gmail.com

## License

MIT
