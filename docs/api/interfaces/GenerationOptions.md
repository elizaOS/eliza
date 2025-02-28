[@elizaos/core v0.25.8](../index.md) / GenerationOptions

# Interface: GenerationOptions

Configuration options for generating objects with a model.

## Properties

### runtime

> **runtime**: [`IAgentRuntime`](IAgentRuntime.md)

#### Defined in

[packages/core/src/generation.ts:2131](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2131)

***

### context

> **context**: `string`

#### Defined in

[packages/core/src/generation.ts:2132](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2132)

***

### modelClass

> **modelClass**: [`ModelClass`](../enumerations/ModelClass.md)

#### Defined in

[packages/core/src/generation.ts:2133](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2133)

***

### schema?

> `optional` **schema**: `ZodType`\<`any`, `ZodTypeDef`, `any`\>

#### Defined in

[packages/core/src/generation.ts:2134](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2134)

***

### schemaName?

> `optional` **schemaName**: `string`

#### Defined in

[packages/core/src/generation.ts:2135](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2135)

***

### schemaDescription?

> `optional` **schemaDescription**: `string`

#### Defined in

[packages/core/src/generation.ts:2136](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2136)

***

### stop?

> `optional` **stop**: `string`[]

#### Defined in

[packages/core/src/generation.ts:2137](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2137)

***

### mode?

> `optional` **mode**: `"auto"` \| `"json"` \| `"tool"`

#### Defined in

[packages/core/src/generation.ts:2138](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2138)

***

### experimental\_providerMetadata?

> `optional` **experimental\_providerMetadata**: `Record`\<`string`, `unknown`\>

#### Defined in

[packages/core/src/generation.ts:2139](https://github.com/elizaOS/eliza/blob/main/packages/core/src/generation.ts#L2139)
