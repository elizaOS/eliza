# @elizaos/plugin-social-alpha

An elizaOS plugin that tracks cryptocurrency token recommendations made by users in chat, evaluates their accuracy against real price outcomes, and builds trust scores for each recommender.

## What it does

- **Recommendation capture.** Every incoming message is analyzed with a single LLM call to detect buy/sell calls ("shills" and "FUD"). Detected calls are stored against the sender's trust profile as an elizaOS Component.
- **Trust scoring.** Scores are calculated using a multi-factor algorithm: profit percentage, win rate, Sharpe ratio, alpha vs market, consistency, and a scam/rug penalty.
- **Leaderboard.** Ranked leaderboard of all tracked recommenders is available as a JSON API and as a dashboard view (`SocialAlphaView`).
- **Agent context injection.** The `socialAlpha` provider injects the current speaker's trust stats and the top/bottom leaderboard into the agent's context automatically, so the agent can factor reputation into its responses.

## Capabilities added to an Eliza agent

| Capability | Description |
|-----------|-------------|
| `socialAlpha` provider | Injects trust scores, win rate, avg P&L, and leaderboard into agent context |
| `MESSAGE_RECEIVED` event handler | Extracts buy/sell signals from messages in real time |
| `CommunityInvestorService` | Manages all trust score and recommendation data |
| `GET /api/social-alpha/leaderboard` route | Returns `LeaderboardEntry[]` JSON |
| `social-alpha` view | Leaderboard dashboard view — appears in the view manager when the plugin is enabled; requires a configured agent wallet |

No actions are added — recommendation capture is event-driven, not agent-initiated.

## How to enable

Add the plugin to your agent's character definition:

```typescript
import { socialAlphaPlugin } from "@elizaos/plugin-social-alpha";

export const character = {
  name: "MyAgent",
  plugins: [socialAlphaPlugin],
  // ...
};
```

## Required configuration

Set these in your agent's environment or character config:

```env
BIRDEYE_API_KEY=        # Token price, security, and trade data (Solana)
DEXSCREENER_API_KEY=    # DEX pair data and ticker resolution
HELIUS_API_KEY=         # Solana holder list data (optional — service degrades gracefully without it)
```

The following are declared as required in `agentConfig` but are not actively used in current code paths:

```env
JUPITER_API_KEY=
COINGECKO_API_KEY=
MORALIS_API_KEY=
```

### Optional tuning

| Setting | Default | Description |
|---------|---------|-------------|
| `PROCESS_TRADE_DECISION_INTERVAL_HOURS` | `1` | How often queued trade decisions are evaluated |
| `METRIC_REFRESH_INTERVAL_HOURS` | `24` | How often recommender metrics are refreshed |
| `USER_TRADE_COOLDOWN_HOURS` | `12` | Minimum hours between decisions per user |
| `SCAM_PENALTY` | `-100` | Trust score penalty for promoting a rug/scam |
| `SCAM_CORRECT_CALL_BONUS` | `100` | Bonus for correctly calling out a scam |
| `MAX_RECOMMENDATIONS_IN_PROFILE` | `50` | Rolling window of recommendations kept per user |

## Trust score algorithm

The balanced trust score uses:

- **Profit** — average percentage gain across evaluated calls
- **Win rate** — proportion of calls that were profitable
- **Sharpe ratio** — risk-adjusted returns
- **Alpha** — excess returns vs market
- **Consistency** — stability of returns over time
- **Quality** — scam/rug penalty applied when a promoted token turns out fraudulent; bonus for correctly calling out scams before they dump

Weights are tunable via `src/services/trustScoreOptimizer.ts`.

## Building the view

The leaderboard UI is a plugin view served at `/api/views/social-alpha/bundle.js`. Build it (react + `@elizaos/ui` stay externalised to the host shell):

```bash
bun run --cwd plugins/plugin-social-alpha build
```

## Running tests

```bash
bun run --cwd plugins/plugin-social-alpha test
```

## Supported chains

Primary support is Solana. Ethereum and Base are partially supported for ticker resolution via DexScreener.

