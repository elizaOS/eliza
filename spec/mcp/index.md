# MCP capabilities

## Story: Call an explicitly enabled server with valid tool arguments

> As the owner, I can select an MCP server and invoke its advertised tools through the agent with input that satisfies the original schema.

### A server connection needs enabled configuration and a validated transport

The VibeLang shell checks local executable and argument policy for stdio, forwards only declared environment values, and uses the runtime's approved outbound HTTP transport for remote endpoints. OAuth tokens and other credentials remain in the shell.

```quint
type McpTransport = StdioTransport | HttpTransport
type McpServer = { serverId: str, serverEpoch: int, transport: McpTransport, enabled: bool }
pure def connectionAllowed(server: McpServer, transportAdmitted: bool): bool =
  server.serverId != "" and server.serverEpoch > 0 and server.enabled and transportAdmitted
pure def lawDisabledServerCannotConnect(server: McpServer, admitted: bool): bool =
  not(server.enabled) implies not(connectionAllowed(server, admitted))
```

### Provider schema projections retain the meaning of omitted constraints in the prompt

The shell bounds, parses, and normalizes the original schema before deriving a provider schema. Structural constraints unsupported by a provider are removed from its wire format, restated in the tool instructions, and enforced against the original schema before any remote tool call.

```quint
type SchemaConstraint = PatternConstraint | UnionConstraint | BoundsConstraint | RequiredConstraint | FormatConstraint
type ToolProjection = { wireConstraints: Set[SchemaConstraint], instructionConstraints: Set[SchemaConstraint] }
pure def projectToolSchema(constraints: Set[SchemaConstraint], omitted: Set[SchemaConstraint]): ToolProjection =
  { wireConstraints: constraints.exclude(omitted), instructionConstraints: constraints.intersect(omitted) }
pure def lawProjectionAccountsForEveryConstraint(constraints: Set[SchemaConstraint], omitted: Set[SchemaConstraint]): bool = {
  val projected = projectToolSchema(constraints, omitted)
  constraints.subseteq(projected.wireConstraints.union(projected.instructionConstraints)) and
    projected.wireConstraints.union(projected.instructionConstraints).subseteq(constraints) and
    projected.wireConstraints.intersect(projected.instructionConstraints).size() == 0
}
```

### An invocation can be sent once only after its original schema accepts the arguments

A callback carries the exact tool, server generation and invocation identifier. Validation may ask the model to repair arguments. Exhausting the bounded attempts or a transport ambiguity does not authorize another submission.

```quint
type InvocationPhase = NeedsArguments | ReadyToInvoke | InvocationSent | InvocationRefused
type McpInvocation = { phase: InvocationPhase, attempts: int, validated: bool, dispatched: int }
pure val maxArgumentsAttempts = 3
pure val initial: McpInvocation = { phase: NeedsArguments, attempts: 0, validated: false, dispatched: 0 }
pure def canObserveArguments(s: McpInvocation): bool = s.phase == NeedsArguments and s.attempts < maxArgumentsAttempts
pure def observeArguments(s: McpInvocation, valid: bool): McpInvocation =
  { ...s, attempts: s.attempts + 1, validated: valid,
    phase: if (valid) ReadyToInvoke else if (s.attempts + 1 == maxArgumentsAttempts) InvocationRefused else NeedsArguments }
pure def canAuthorizeInvocation(s: McpInvocation): bool = s.phase == ReadyToInvoke and s.validated and s.dispatched == 0
pure def authorizeInvocation(s: McpInvocation): McpInvocation = { ...s, phase: InvocationSent, dispatched: 1 }
pure def alwaysOnlyValidArgumentsSend(s: McpInvocation): bool = s.dispatched > 0 implies s.validated
pure def alwaysAtMostOneInvocation(s: McpInvocation): bool =
  (s.dispatched == 0 or s.dispatched == 1) and (s.dispatched == 1 iff s.phase == InvocationSent)
pure def alwaysArgumentAttemptsAreBounded(s: McpInvocation): bool = s.attempts >= 0 and s.attempts <= maxArgumentsAttempts
pure def sometimesArgumentsAcceptedOnRetry(s: McpInvocation): bool = s.phase == InvocationSent and s.attempts == 2
pure val eval_witness_sometimesArgumentsAcceptedOnRetry = (("observeArguments", false), ("observeArguments", true), "authorizeInvocation")
pure val serverValues = Set({ serverId: "calendar", serverEpoch: 1, transport: HttpTransport, enabled: true }, { serverId: "calendar", serverEpoch: 2, transport: StdioTransport, enabled: false })
```
