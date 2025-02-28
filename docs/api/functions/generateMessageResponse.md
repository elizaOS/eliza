[@elizaos/core v0.25.8](../index.md) / generateMessageResponse

# Function: generateMessageResponse()

> **generateMessageResponse**(`opts`): `Promise`\<[`Content`](../interfaces/Content.md)\>

Send a message to the model for generateText.

## Parameters

• **opts**

The options for the generateText request.

• **opts.runtime**: [`IAgentRuntime`](../interfaces/IAgentRuntime.md)

• **opts.context**: `string`

The context of the message to be completed.

• **opts.modelClass**: [`ModelClass`](../enumerations/ModelClass.md)

## Returns

`Promise`\<[`Content`](../interfaces/Content.md)\>

The completed message.

## Defined in

[packages/core/src/generation.ts:1661](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L1661)
