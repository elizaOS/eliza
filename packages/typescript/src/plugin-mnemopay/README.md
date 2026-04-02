# plugin-mnemopay

Economic memory for Eliza AI agents. Agents remember payment outcomes, learn from settlements and refunds, and build reputation over time.

Powered by [MnemoPay](https://github.com/t49qnsx7qt-kpanks/mnemopay-sdk) (`@mnemopay/sdk`).

## Why economic memory?

Standard AI agents treat every financial interaction as a blank slate. MnemoPay gives agents the ability to:

- **Remember** which providers delivered quality work and which didn't
- **Learn** from payment disputes and successful settlements
- **Build reputation** through consistent positive outcomes
- **Make informed decisions** by recalling past financial experiences

## Components

### Service: `MnemoPayService`

Manages the MnemoPayLite engine lifecycle. Initializes on agent startup and exposes the engine to other components via `runtime.getService("mnemopay")`.

### Actions

| Action | Description | Trigger examples |
|--------|-------------|-----------------|
| `REMEMBER_OUTCOME` | Store a payment/interaction outcome | "Remember that Provider X delivered quality work" |
| `CHARGE_PAYMENT` | Create an escrow payment | "Charge $50 for the design task" |
| `SETTLE_PAYMENT` | Settle payment, reinforce reputation | "Settle payment tx_agent_1_123" |
| `REFUND_PAYMENT` | Refund payment, dock reputation | "Refund the last payment" |
| `RECALL_MEMORIES` | Query economic memory | "What do you know about Provider X?" |

### Provider: `MnemoPayProvider`

Injects the agent's wallet balance, reputation score, recent transactions, and relevant memories into every conversation context. The LLM sees the agent's full financial state.

### Evaluator: `MnemoPayEvaluator`

Runs after every agent response. Detects financial keywords and automatically stores outcomes in economic memory with appropriate importance levels and tags. This creates a passive learning loop.

## Configuration

Set via environment variables or character settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMOPAY_AGENT_ID` | `runtime.agentId` | Custom agent identifier |
| `MNEMOPAY_REPUTATION_DELTA` | `0.05` | Reputation change per settle/refund |

## Usage

```typescript
import { createMnemoPayPlugin } from "./plugin-mnemopay";

const agent: ProjectAgent = {
  character: myCharacter,
  plugins: [createMnemoPayPlugin()],
};
```

## How it works

1. **Agent charges a payment** → Amount held in escrow, wallet debited
2. **Work is delivered** → Agent settles (reputation +0.05) or refunds (reputation -0.05)
3. **Evaluator auto-tracks** → Financial outcomes stored in memory with importance scores
4. **Future decisions** → Provider surfaces relevant memories and reputation in context
5. **Agent recalls** → Queries past experiences to evaluate providers and make decisions

## Events

The service emits events that can be listened to:

- `memory:stored` — When a new economic memory is created
- `memory:recalled` — When memories are queried
- `payment:completed` — When a payment charge is created
- `payment:refunded` — When a payment is refunded
- `reputation:changed` — When reputation score changes

## License

MIT
