# Native agent bridge

The Android process and socket are owned by [agent lifecycle](../os/agentService/lifecycle.md) and [agent channel](../os/agentService/channel.md). This bridge contracts the app-local facade for start, stop, status, chat, typed requests, streams and feeds.

## Story: Use the agent that belongs to this device session

> As a local app, I want each call and notification bound to the process and owner that admitted it, with stale streams retired during restart.

### A bridge reply and event belong to the current agent generation

The bridge adapter returns a local route only from an authenticated, ready process. An event subscription is tied to both the owner and the generation; stream and feed transports remain distinct from the reply's application status.

```quint
type AgentBridgePhase = BridgeStopped | BridgeStarting | BridgeReady
type AgentBridge = { phase: AgentBridgePhase, generation: int, ownerId: str }
pure val initial: AgentBridge = { phase: BridgeStopped, generation: 0, ownerId: "" }
pure def canBeginNativeAgent(s: AgentBridge, ownerId: str): bool = s.phase == BridgeStopped and ownerId != ""
pure def beginNativeAgent(s: AgentBridge, ownerId: str): AgentBridge =
  { phase: BridgeStarting, generation: s.generation + 1, ownerId: ownerId }
pure def canObserveNativeAgentReady(s: AgentBridge, generation: int, ownerId: str): bool =
  s.phase == BridgeStarting and s.generation == generation and s.ownerId == ownerId
pure def observeNativeAgentReady(s: AgentBridge, generation: int, ownerId: str): AgentBridge = { ...s, phase: BridgeReady }
pure def canStopNativeAgent(s: AgentBridge): bool = s.phase != BridgeStopped
pure def stopNativeAgent(s: AgentBridge): AgentBridge = { ...initial, generation: s.generation }
pure def mayDeliverAgentReply(s: AgentBridge, generation: int, ownerId: str): bool =
  s.phase == BridgeReady and s.generation == generation and s.ownerId == ownerId
pure def alwaysActiveAgentHasOwner(s: AgentBridge): bool = s.phase != BridgeStopped implies s.ownerId != ""
pure def stepAgentGenerationNeverMovesBack(before: AgentBridge, after: AgentBridge): bool =
  before.generation <= after.generation
pure def sometimesNativeAgentReady(s: AgentBridge): bool = s.phase == BridgeReady
pure val generationValues = Set(0, 1, 2)
pure val ownerIdValues = Set("", "owner", "other")
```
