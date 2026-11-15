# Wire contracts

`@elizaos/contracts` holds the browser-safe shapes, constants and input
checks that a client, a host and the agent must read the same way. Each
contract here is a library: pure definitions of what a value means and laws
that hold for every value. Nothing in this package stores, authorizes or
performs an effect; the package that owns a record keeps its storage,
permission and approval, and imports these definitions to read the shape.

Each spec models the text of a wire value as the facts its parser observes
(is it blank, does it carry credentials, does it parse as a URL), so the
laws hold whatever bytes a client sends. The data that only names values,
such as the list of top-level domains a browser accepts, stays data in the
implementation and has no rule.

The telephony, workflow and assistant record types are read by the specs
that own those records ([device actions](../agent/deviceActions/),
[workflows](../workflow/), [personal assistance](../assistant/)) and have no
rules of their own here.

| Contract | Specification |
| --- | --- |
| Address bar input | [Browser address](./browserAddress.md) |
| What the client shows this turn | [Client turn observation](./clientTurnObservation.md) |
| The Undo window of a reviewed deletion | [Deletion window](./deletionWindow.md) |
| Clock times stated in text | [Stated clock time](./statedClockTime.md) |
| The pairing link of a remote agent | [Remote agent pairing](./remoteAgentPairing.md) |
| Reviews a device resolves in the foreground | [Device reviews](./deviceReviews.md) |
| Native notice routes | [Notice routes](./noticeRoutes.md) |
