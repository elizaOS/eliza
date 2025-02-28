[@elizaos/core v0.25.8](../index.md) / generateObject

# Function: generateObject()

> **generateObject**(`options`): `Promise`\<`GenerateObjectResult`\<`unknown`\>\>

Generates structured objects from a prompt using specified AI models and configuration options.

## Parameters

• **options**: [`GenerationOptions`](../interfaces/GenerationOptions.md)

Configuration options for generating objects.

## Returns

`Promise`\<`GenerateObjectResult`\<`unknown`\>\>

- A promise that resolves to an array of generated objects.

## Throws

- Throws an error if the provider is unsupported or if generation fails.

## Defined in

[packages/core/src/generation.ts:2165](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2165)
