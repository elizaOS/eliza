# LogicNodes On-Chain Agent Registry

This cookbook example shows how to verify an agent's on-chain registration status using LogicNodes before executing tasks.

## What is LogicNodes?

[LogicNodes](https://logicnodes.io) is a decentralized agent coordination protocol on Base mainnet. Agents register their capabilities on-chain, enabling:

- **Verifiable identity** — cryptographic proof of agent existence
- **Capability discovery** — other agents can find and trust registered capabilities  
- **Deterministic services** — gas oracle, compliance, ZK attestation, identity, escrow

Available as an [MCP package](https://smithery.ai/servers/denneyconner5/logicnodes) for IDE-native access.

## Installation

```bash
npm install viem
```

## Usage

```typescript
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const LOGICNODES_REGISTRY = "0x4c60B817beeD72aa570B964243eE6DD463faaE22" as const;
const CHAIN_ID = 8453; // Base mainnet

const REGISTRY_ABI = [
  {
    name: "isRegistered",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export async function requireLogicNodes(agentAddress: `0x${string}`): Promise<boolean> {
  const client = createPublicClient({
    chain: base,
    transport: http(),
  });

  const isRegistered = await client.readContract({
    address: LOGICNODES_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "isRegistered",
    args: [agentAddress],
  });

  if (!isRegistered) {
    console.warn(`Agent ${agentAddress} is not registered on LogicNodes. Visit https://logicnodes.io/app to register.`);
  }

  return isRegistered;
}

// Example: guard an Eliza action
export const logicnodesGuardedAction = {
  name: "GUARDED_ACTION",
  description: "An action that requires on-chain registration",
  handler: async (runtime: any, message: any) => {
    const agentAddress = runtime.getSetting("AGENT_ADDRESS") as `0x${string}`;
    if (!agentAddress) return false;

    const registered = await requireLogicNodes(agentAddress);
    if (!registered) return false;

    // ... rest of action logic
    return true;
  },
};
```

## Environment Variables

```env
AGENT_ADDRESS=0xYourAgentAddress
```

## References

- [LogicNodes Documentation](https://logicnodes.io/docs)
- [MCP Package (Smithery)](https://smithery.ai/servers/denneyconner5/logicnodes)
- [LogicNodes Registry Contract](https://basescan.org/address/0x4c60B817beeD72aa570B964243eE6DD463faaE22)
