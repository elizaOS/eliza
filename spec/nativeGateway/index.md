# Native gateway

Discovery observes local endpoints. Connecting, sending RPCs and receiving realtime events are separate steps, with a per-connection generation supplied by the authenticated transport.

## Story: Connect to the gateway I chose and isolate its replies

> As the owner, I want discovered gateways kept apart from an authenticated connection so a replaced gateway cannot receive requests or deliver stale events.

### Discovery does not create a connected gateway

A pending connection names the selected endpoint. A successful handshake promotes only that endpoint and that generation. Disconnect makes subsequent sends and notifications unavailable.

```quint
type GatewayPhase = NoGateway | GatewayHandshaking | GatewayConnected
type GatewayConnection = { phase: GatewayPhase, endpointId: str, connectionGeneration: int }
pure val initial: GatewayConnection = { phase: NoGateway, endpointId: "", connectionGeneration: 0 }
pure def canConnectGateway(s: GatewayConnection, endpointId: str): bool = s.phase == NoGateway and endpointId != ""
pure def connectGateway(s: GatewayConnection, endpointId: str): GatewayConnection =
  { phase: GatewayHandshaking, endpointId: endpointId, connectionGeneration: s.connectionGeneration + 1 }
pure def canConfirmGateway(s: GatewayConnection, endpointId: str, generation: int, authenticated: bool): bool =
  s.phase == GatewayHandshaking and s.endpointId == endpointId and s.connectionGeneration == generation and authenticated
pure def confirmGateway(s: GatewayConnection, endpointId: str, generation: int, authenticated: bool): GatewayConnection =
  { ...s, phase: GatewayConnected }
pure def canDisconnectGateway(s: GatewayConnection): bool = s.phase != NoGateway
pure def disconnectGateway(s: GatewayConnection): GatewayConnection =
  { ...initial, connectionGeneration: s.connectionGeneration }
pure def mayRouteGatewayRpc(s: GatewayConnection, endpointId: str, generation: int): bool =
  s.phase == GatewayConnected and s.endpointId == endpointId and s.connectionGeneration == generation
pure def alwaysGatewayHasEndpoint(s: GatewayConnection): bool = s.phase != NoGateway implies s.endpointId != ""
pure def sometimesAuthenticatedGateway(s: GatewayConnection): bool = s.phase == GatewayConnected
pure val endpointIdValues = Set("", "first", "second")
pure val generationValues = Set(0, 1, 2, 3)
```
