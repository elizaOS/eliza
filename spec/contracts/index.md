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

The workflow and assistant record types are read by the specs that own
those records ([workflows](../workflow/),
[personal assistance](../assistant/)) and have no rules of their own here.
The telephony records are read the same way by their owners, with one rule
each:

| Telephony record | Owner rule |
| --- | --- |
| A reviewed text message, its bounds and its subscription | [device effect authority](../agent/deviceActions/telephonyReview.md), "A direct SMS is bounded and uses an active subscription" |
| The receipt of a sent text message | [device reviews](./deviceReviews.md), "A text message's reported status is supported by the evidence of every part" |
| A dial handoff and a placed call, and their receipts | [device reviews](./deviceReviews.md), "A dial is applied only when the dial screen opened, and no dial or call receipt claims a connected call" |
| Who may authorize a call, a contact change or a message | [device effect authority](../agent/deviceActions/telephonyReview.md), "A device effect needs review unless the current request may act directly" |
| One attempt at a device effect from a screen | [device action custody](../agent/deviceActions/execution.md), "Dispatch needs an exact reservation and server claim" |

| Contract | Specification |
| --- | --- |
| Address bar input | [Browser address](./browserAddress.md) |
| What the client shows this turn | [Client turn observation](./clientTurnObservation.md) |
| The Undo window of a reviewed deletion | [Deletion window](./deletionWindow.md) |
| Clock times stated in text | [Stated clock time](./statedClockTime.md) |
| The pairing link of a remote agent | [Remote agent pairing](./remoteAgentPairing.md) |
| Reviews a device resolves in the foreground, and telephony receipts | [Device reviews](./deviceReviews.md) |
| Native notice routes | [Notice routes](./noticeRoutes.md) |
