[@elizaos/core v0.25.7](../index.md) / MemoryCacheAdapter

# Class: MemoryCacheAdapter

## Implements

- [`ICacheAdapter`](../interfaces/ICacheAdapter.md)

## Constructors

### new MemoryCacheAdapter()

> **new MemoryCacheAdapter**(`initalData`?): [`MemoryCacheAdapter`](MemoryCacheAdapter.md)

#### Parameters

• **initialData?**: `Map`\<`string`, `string`\>

#### Returns

[`MemoryCacheAdapter`](MemoryCacheAdapter.md)

#### Defined in

[packages/core/src/cache.ts:19](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L19)

## Properties

### data

> **data**: `Map`\<`string`, `string`\>

#### Defined in

[packages/core/src/cache.ts:17](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L17)

## Methods

### get()

> **get**(`key`): `Promise`\<`string`\>

#### Parameters

• **key**: `string`

#### Returns

`Promise`\<`string`\>

#### Implementation of

[`ICacheAdapter`](../interfaces/ICacheAdapter.md).[`get`](../interfaces/ICacheAdapter.md#get)

#### Defined in

[packages/core/src/cache.ts:23](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L23)

***

### set()

> **set**(`key`, `value`): `Promise`\<`void`\>

#### Parameters

• **key**: `string`

• **value**: `string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`ICacheAdapter`](../interfaces/ICacheAdapter.md).[`set`](../interfaces/ICacheAdapter.md#set)

#### Defined in

[packages/core/src/cache.ts:27](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L27)

***

### delete()

> **delete**(`key`): `Promise`\<`void`\>

#### Parameters

• **key**: `string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`ICacheAdapter`](../interfaces/ICacheAdapter.md).[`delete`](../interfaces/ICacheAdapter.md#delete)

#### Defined in

[packages/core/src/cache.ts:31](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L31)
