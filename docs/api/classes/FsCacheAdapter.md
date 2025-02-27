[@elizaos/core v0.25.7](../index.md) / FsCacheAdapter

# Class: FsCacheAdapter

## Implements

- [`ICacheAdapter`](../interfaces/ICacheAdapter.md)

## Constructors

### new FsCacheAdapter()

> **new FsCacheAdapter**(`dataDir`): [`FsCacheAdapter`](FsCacheAdapter.md)

#### Parameters

• **dataDir**: `string`

#### Returns

[`FsCacheAdapter`](FsCacheAdapter.md)

#### Defined in

[packages/core/src/cache.ts:37](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L37)

## Methods

### get()

> **get**(`key`): `Promise`<`string`>

#### Parameters

• **key**: `string`

#### Returns

`Promise`<`string`>

#### Implementation of

[`ICacheAdapter`](../interfaces/ICacheAdapter.md).[`get`](../interfaces/ICacheAdapter.md#get)

#### Defined in

[packages/core/src/cache.ts:39](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L39)

***

### set()

> **set**(`key`, `value`): `Promise`<`void`>

#### Parameters

• **key**: `string`

• **value**: `string`

#### Returns

`Promise`<`void`>

#### Implementation of

[`ICacheAdapter`](../interfaces/ICacheAdapter.md).[`set`](../interfaces/ICacheAdapter.md#set)

#### Defined in

[packages/core/src/cache.ts:48](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L48)

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

[packages/core/src/cache.ts:59](https://github.com/elizaOS/eliza/blob/main/packages/core/src/cache.ts#L59)
