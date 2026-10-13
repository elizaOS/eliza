# @elizaos/plugin-canaryguard

Deterministic heuristic detector for prompt injection, concealed Unicode, and malicious wallet-drain commands in ElizaOS agents.

## Architecture

- **Local-First & Offline Engine (Default)**: Runs 100% in-process via compiled deterministic rules. Takes <0.1ms per scan, requires zero external services, and preserves full user privacy by never transmitting message text over the network.
- **Instruction Override Defense**: Detects and scrubs system prompt overrides, stacked modifier attacks, role-play exploits, and delimiter breaks.
- **Wallet Transfer Defense**: Detects and flags unauthorized EVM and Solana token transfer commands, address extractions, and drain attempts.
- **Optional Remote Oracle**: Operators can optionally configure an external verification endpoint or x402 gateway via `CANARYGUARD_URL`.

## Installation

```bash
elizaos plugins add canaryguard
```

## Configuration

Optional parameters configurable via runtime settings (`runtime.getSetting`) or environment variables:

| Setting | Type | Description | Default |
| --- | --- | --- | --- |
| `CANARYGUARD_URL` | string | Optional remote service URL. When unset, runs 100% offline locally. | `undefined` (Offline) |
| `CANARYGUARD_PAYMENT_HEADER` | string | Optional x402 payment signature for authenticated remote queries. | `undefined` |
| `CANARYGUARD_STRICT_MODE` | boolean | When true, completely blanks blocked messages; when false, strips offending command lines. | `true` |

## Actions

- **`CANARY_SANITIZE`**: Scans and sanitizes untrusted text (scraped HTML, tool inputs, user messages) before context ingestion or execution. Returns an `ActionResult` with inspection telemetry.

## Providers

- **`canaryGuardProvider`**: Injects active heuristic detector status and scan counts into the agent context via `ProviderResult`.
