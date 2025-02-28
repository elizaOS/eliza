[@elizaos/core v0.25.8](../index.md) / generateImage

# Function: generateImage()

> **generateImage**(`data`, `runtime`): `Promise`\<`object`\>

## Parameters

• **data**

• **data.prompt**: `string`

• **data.width**: `number`

• **data.height**: `number`

• **data.count?**: `number`

• **data.negativePrompt?**: `string`

• **data.numIterations?**: `number`

• **data.guidanceScale?**: `number`

• **data.seed?**: `number`

• **data.modelId?**: `string`

• **data.jobId?**: `string`

• **data.stylePreset?**: `string`

• **data.hideWatermark?**: `boolean`

• **data.safeMode?**: `boolean`

• **data.cfgScale?**: `number`

• **runtime**: [`IAgentRuntime`](../interfaces/IAgentRuntime.md)

## Returns

`Promise`\<`object`\>

### success

> **success**: `boolean`

### data?

> `optional` **data**: `string`[]

### error?

> `optional` **error**: `any`

## Defined in

[packages/core/src/generation.ts:1704](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L1704)
