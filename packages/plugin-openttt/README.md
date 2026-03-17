# @elizaos/plugin-openttt

OpenTTT Proof-of-Time plugin for ElizaOS — temporal attestation for AI agent transactions.

## What it does

Every agent trade or transaction carries a timestamp — but timestamps can be forged.
This plugin attaches a **Proof-of-Time (PoT)** token to each transaction by querying
four independent time sources (NIST, Apple, Google, Cloudflare) and computing a
consensus timestamp. The result is a tamper-evident temporal attestation that any
counterparty can verify.

Under the hood, PoT tokens pass through a 3-layer integrity pipeline before being
issued, ensuring the attested time is both accurate and unforgeable.

## Install

```bash
npm install @elizaos/plugin-openttt
```

`@elizaos/core` must be installed as a peer dependency in your ElizaOS project.

## Register the plugin

```typescript
import { openTTTPlugin } from "@elizaos/plugin-openttt";
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  // ...your config
  plugins: [openTTTPlugin],
});
```

## Usage

### Before a trade — generate a PoT token

The agent will call `GENERATE_POT` automatically when it detects trade intent,
or you can trigger it explicitly:

```
User: Generate a proof of time before I submit this swap
Agent: Proof-of-Time generated successfully.

  Timestamp : 2026-03-17T07:00:00.000Z
  Sources   : NIST, Apple, Google, Cloudflare
  Consensus : ✓ CONSENSUS
  Deviation : 87ms
  Nonce     : 6f70656e7474740a3d2f...
```

### After a trade — verify the PoT token

```
User: Verify the proof of time on my last transaction
Agent: Proof-of-Time verification PASSED.

  Issued    : 2026-03-17T07:00:00.000Z
  Age       : 8s
  Sources   : NIST, Apple, Google, Cloudflare
  Consensus : ✓ CONSENSUS
  Deviation : 87ms
```

### Automatic coverage check

The `potEvaluator` runs automatically on any message containing trade keywords
(`trade`, `swap`, `buy`, `sell`, `submit`, `execute`, etc.) and warns if a
transaction is missing PoT coverage:

```
[POT_COVERAGE_EVALUATOR] ⚠ No Proof-of-Time found for this transaction.
Consider calling GENERATE_POT before submitting trades.
```

## API

### Plugin object

```typescript
import { openTTTPlugin } from "@elizaos/plugin-openttt";
// openTTTPlugin.actions    → [generatePot, verifyPot]
// openTTTPlugin.providers  → [timeProvider]
// openTTTPlugin.evaluators → [potEvaluator]
```

### Standalone utilities

```typescript
import { getVerifiedTime } from "@elizaos/plugin-openttt";

const vt = await getVerifiedTime();
// {
//   timestamp: 1742194800000,
//   sources: ["NIST", "Apple", "Google", "Cloudflare"],
//   consensus: true,
//   deviation_ms: 87
// }
```

### Types

```typescript
import type { PoTToken, VerifyResult, VerifiedTime } from "@elizaos/plugin-openttt";
```

## Time sources

| Source     | Endpoint                   |
|------------|----------------------------|
| NIST       | https://time.nist.gov      |
| Apple      | https://www.apple.com      |
| Google     | https://www.google.com     |
| Cloudflare | https://www.cloudflare.com |

Consensus is reached when all responding sources agree within 2 seconds.
If fewer than 2 sources respond, the plugin falls back to local system time
and sets `consensus: false`.

> **Precision disclaimer:** HTTP `Date` headers provide approximately
> **1-second precision**. This is sufficient for trade-ordering attestation
> at human timescales. For sub-second ordering guarantees (e.g. high-frequency
> MEV sequencing), use the full OpenTTT SDK with on-chain anchoring instead
> of this HTTP-based provider.

## License

MIT — see [LICENSE](../../LICENSE)
