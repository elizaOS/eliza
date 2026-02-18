# @elizaos/plugin-scout

Scout trust intelligence plugin for [ElizaOS](https://github.com/elizaOS/eliza) - gives your agent the ability to verify x402 services, scan skills for security issues, and make trust-aware transaction decisions.

## What It Does

| Action | Description |
|---|---|
| **CHECK_SERVICE_TRUST** | Score any x402 service across 4 trust pillars (Contract Clarity, Availability, Response Fidelity, Identity & Safety) |
| **CHECK_FIDELITY** | Probe whether a service actually follows the x402 protocol and delivers what it advertises |
| **SCAN_SKILL** | Scan a skill or MCP server for security issues before installing |
| **BROWSE_LEADERBOARD** | Discover trusted x402 services by category |
| **BATCH_SCORE_SERVICES** | Score up to 20 services at once for comparison |

Plus 2 providers (auto trust context injection, trust policy), 1 evaluator (transaction safety guard), and 1 background service (trust score monitoring).

## Usage

Add the plugin to your agent's character file:

```json
{
  "plugins": ["@elizaos/plugin-scout"]
}
```

Or register programmatically:

```typescript
import { scoutPlugin } from "@elizaos/plugin-scout";

const agent = new AgentRuntime({
  plugins: [scoutPlugin],
});
```

## Configuration

Set these environment variables (all optional - sensible defaults provided):

| Variable | Default | Description |
|---|---|---|
| `SCOUT_API_URL` | `https://scoutscore.ai` | Scout API base URL |
| `SCOUT_MIN_SERVICE_SCORE` | `50` | Minimum trust score for x402 payments |
| `SCOUT_AUTO_REJECT_FLAGS` | `WALLET_SPAM_FARM,TEMPLATE_SPAM,ENDPOINT_DOWN` | Comma-separated auto-reject flags |
| `SCOUT_CACHE_TTL` | `30` | Cache TTL in minutes |
| `SCOUT_WATCHED_DOMAINS` | _(empty)_ | Comma-separated domains to monitor |
| `SCOUT_WATCH_INTERVAL` | `60` | Monitor check interval in minutes |
| `SCOUT_API_KEY` | _(empty)_ | API key for authenticated endpoints |

## How It Works

### Providers

The **trust-context** provider automatically injects trust data about any domain mentioned in conversation. The LLM sees this context without the user needing to explicitly ask:

```
Trust context for questflow.ai: Score 78/100 (HIGH).
Pillars: Contract 85, Availability 100, Fidelity 72, Safety 55.
Verdict: RECOMMENDED (max $5,000). Health: UP (142ms).
```

### Transaction Guard

The **transaction-guard** evaluator watches for payment-related messages. If a user tries to pay an untrusted service, the agent warns or blocks:

```
Transaction BLOCKED: sketchy-api.xyz (score 18/100, VERY_LOW)
has auto-reject flags: ENDPOINT_DOWN, WALLET_SPAM_FARM.
This service is not safe for x402 payments.
```

### Trust Policy

The **trust-policy** provider injects the agent's configured risk tolerance so the LLM respects thresholds when making decisions.

## Trust Levels

| Score | Level | Verdict | Max Transaction |
|---|---|---|---|
| >= 75 | HIGH | RECOMMENDED | $5,000 |
| >= 50 | MEDIUM | USABLE | $1,000 |
| >= 25 | LOW | CAUTION | $100 |
| < 25 | VERY_LOW | NOT_RECOMMENDED | $0 |

## Scout API

This plugin calls the [ScoutScore](https://scoutscore.ai) hosted API. All scoring endpoints are free during the launch period. The plugin uses aggressive caching (30-min TTL by default) to minimize API calls.

## Development

```bash
# Build
bun run build

# Test (236 unit tests)
bun run test

# Lint
bun run lint
```

## License

MIT