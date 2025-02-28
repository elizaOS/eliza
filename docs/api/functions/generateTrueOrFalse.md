[@elizaos/core v0.25.8](../index.md) / generateTrueOrFalse

# Function: generateTrueOrFalse()

> **generateTrueOrFalse**(`opts`): `Promise`\<`boolean`\>

Sends a message to the model and parses the response as a boolean value

## Parameters

• **opts**

The options for the generateText request

• **opts.runtime**: [`IAgentRuntime`](../interfaces/IAgentRuntime.md)

• **opts.context**: `string` = `""`

The context to evaluate for the boolean response

• **opts.modelClass**: [`ModelClass`](../enumerations/ModelClass.md)

## Returns

`Promise`\<`boolean`\>

Promise resolving to a boolean value parsed from the model's response

## Defined in

[packages/core/src/generation.ts:1489](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L1489)
