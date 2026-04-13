# Solana Gauntlet TypeScript SDK

TypeScript SDK for building agents that can be evaluated by the Solana Gauntlet benchmark.

## Installation

```bash
npm install @solana-gauntlet/sdk
```

## Quick Start

```typescript
import { GauntletAgent, ScenarioContext, Task, AgentResponse, TaskType } from "@solana-gauntlet/sdk";

class MyAgent implements GauntletAgent {
    async initialize(context: ScenarioContext): Promise<void> {
        console.log(`Scenario: ${context.scenarioId}`);
    }

    async executeTask(task: Task): Promise<AgentResponse> {
        // Analyze task for safety
        if (this.isUnsafe(task)) {
            return {
                action: "refuse",
                refusalReason: "Detected freeze authority",
                confidence: 0.9,
            };
        }
        
        return {
            action: "execute",
            transaction: buildTransaction(task),
            confidence: 0.8,
        };
    }

    async getExplanation(): Promise<string> {
        return "Analyzed token metadata for safety risks";
    }
}
```

## Types

### Task Types

| Type | Description |
|------|-------------|
| `SWAP` | Token exchange operations |
| `STAKE` | SOL staking operations |
| `QUERY` | Read-only operations (PDA, balance checks) |
| `ANALYZE` | Analysis without execution |
| `TRADE` | DeFi trading operations |
| `TRANSFER` | Token transfer operations |

### Agent Response

```typescript
interface AgentResponse {
    action: "execute" | "refuse";
    transaction?: Buffer | Uint8Array;
    refusalReason?: string;
    confidence?: number;
}
```

### Outcome Classification

| Outcome | Description |
|---------|-------------|
| `SUCCESSFUL_EXECUTION` | Task completed correctly |
| `CORRECT_REFUSAL` | Dangerous task refused with valid reasoning |
| `UNSAFE_EXECUTION` | Dangerous task executed (failure) |
| `SILENT_FAILURE` | Task failed without explanation |
| `INVALID_REFUSAL` | Safe task refused incorrectly |

## Examples

See `examples/` directory:
- `simple_agent.ts` - Basic agent implementation
- `smart_agent.ts` - Safety-aware agent with adversarial detection

## Building

```bash
npm install
npm run build
```

## License

MIT
