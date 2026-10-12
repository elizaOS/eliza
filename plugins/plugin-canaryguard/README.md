# @elizaos/plugin-canaryguard

Deterministic prompt-injection firewall, concealed Unicode scrubber, and malicious wallet-drain defense for ElizaOS agents on Base mainnet via the x402 protocol.

## Features

- **Deterministic <5ms Latency**: Zero LLM-in-the-loop overhead or hallucination risks.
- **Prompt Injection Defense**: Scrubs system prompt overrides, delimiter breaks, role-play exploits, and canary honeypot triggers.
- **Malicious Wallet Transfer Defense**: Detects and flags unauthorized address extractions and drain attempts.
- **x402 Protocol Native**: Integrates with the Coinbase CDP x402 Bazaar on Base mainnet (\$0.003 USDC per call).

## Installation

```bash
elizaos plugins add canaryguard
```

Or install the standalone package:

```bash
npm install @kurox_real/plugin-canaryguard
```

## Configuration

Add the following optional variables to your `.env` or agent character configuration:

```env
CANARYGUARD_URL=https://canaryguard-402.onrender.com
CANARYGUARD_PAYMENT_HEADER=optional_x402_signature_header
```

## Actions

### `CANARY_SANITIZE`
Explicitly inspects and sanitizes untrusted text (scraped HTML, user messages, third-party tool outputs) before context ingestion or tool execution.
