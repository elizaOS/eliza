# @elizaos/plugin-canaryguard

Deterministic prompt-injection firewall, concealed Unicode scrubber, and malicious wallet-drain defense for ElizaOS agents.

## Architecture

- **Local-First & Offline Engine (Default)**: Runs 100% in-process via compiled deterministic rules. Takes <0.1ms per scan, requires zero external services, and preserves full privacy by never transmitting message text over the network.
- **Prompt Injection Defense**: Scrubs system prompt overrides, delimiter breaks, role-play exploits, and canary honeypot triggers.
- **Wallet Transfer Defense**: Detects and flags unauthorized token transfer commands, address extractions, and drain attempts.
- **Optional Remote Oracle**: Operators can optionally configure an external verification endpoint or x402 gateway via `CANARYGUARD_URL`.

## Installation

```bash
elizaos plugins add canaryguard
```

## Configuration

Optional parameters configurable via runtime settings or environment variables:

| Setting | Type | Description | Default |
| --- | --- | --- | --- |
| `CANARYGUARD_URL` | string | Optional remote service URL. When unset, runs 100% offline locally. | `undefined` (Offline) |
| `CANARYGUARD_PAYMENT_HEADER` | string | Optional x402 payment signature for authenticated remote queries. | `undefined` |
| `CANARYGUARD_STRICT_MODE` | boolean | When true, completely blanks blocked messages; when false, strips commands. | `true` |

## Actions

- **`CANARY_SANITIZE`**: Scans and sanitizes untrusted text (scraped HTML, tool inputs, user messages) before context ingestion or execution.

## Evaluators

- **`PROMPT_INJECTION_EVALUATOR`**: In-memory inspection of user turns to flag instruction overrides before memory persistence.

## Providers

- **`canaryGuardProvider`**: Injects active firewall status and telemetry into the agent context.
