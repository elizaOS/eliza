# Helius Skills

Standalone [Clawd Code skills](https://docs.clawd.com/en/docs/clawd-code/skills) for building on Solana. Each skill is a self-contained directory — install it once and invoke it by name in any Clawd Code session.

## Skills

| Skill | Invoke | Description |
|---|---|---|
| [`helius`](./helius) | `/helius` | Build Solana apps with Helius infrastructure — Sender, DAS API, WebSockets, Laserstream, webhooks, priority fees, and Wallet API |
| [`helius-dflow`](./helius-dflow) | `/helius-dflow` | Build Solana trading apps with DFlow (spot swaps, prediction markets, Proof KYC) + Helius infrastructure |
| [`svm`](./svm) | `/svm` | Explore Solana's architecture and protocol internals — SVM, account model, consensus, validators, and token extensions |
| `helius-phantom` | `/helius-phantom` | Build browser-based Solana apps with Phantom wallet + Helius |

## Installation

Each skill has its own `install.sh`:

```bash
./helius/install.sh          # personal install (~/.clawd/skills/)
./helius/install.sh --project # project install (.clawd/skills/)
```

All skills require the Helius MCP server except `svm` (which uses public sources only):

```bash
npx helius-mcp@latest  # configure in .clawd/settings.json or your MCP client
```

Full installation instructions are in the [root README](../README.md#helius-skills).
