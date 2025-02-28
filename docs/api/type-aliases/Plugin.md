[@elizaos/core v0.25.8](../index.md) / Plugin

# Type Alias: Plugin

> **Plugin**: `object`

Plugin for extending agent functionality

## Type declaration

### name

> **name**: `string`

Plugin name

### npmName?

> `optional` **npmName**: `string`

Plugin npm name

### config?

> `optional` **config**: `object`

Plugin configuration

#### Index Signature

 \[`key`: `string`\]: `any`

### description

> **description**: `string`

Plugin description

### actions?

> `optional` **actions**: [`Action`](../interfaces/Action.md)[]

Optional actions

### providers?

> `optional` **providers**: [`Provider`](../interfaces/Provider.md)[]

Optional providers

### evaluators?

> `optional` **evaluators**: [`Evaluator`](../interfaces/Evaluator.md)[]

Optional evaluators

### services?

> `optional` **services**: [`Service`](../classes/Service.md)[]

Optional services

### clients?

> `optional` **clients**: [`Client`](Client.md)[]

Optional clients

### adapters?

> `optional` **adapters**: [`Adapter`](Adapter.md)[]

Optional adapters

### handlePostCharacterLoaded()?

> `optional` **handlePostCharacterLoaded**: (`char`) => `Promise`\<[`Character`](Character.md)\>

Optional post charactor processor handler

#### Parameters

• **char**: [`Character`](Character.md)

#### Returns

`Promise`\<[`Character`](Character.md)\>

## Defined in

[packages/core/src/types.ts:650](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L650)
