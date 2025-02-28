[@elizaos/core v0.25.8](../index.md) / IPdfService

# Interface: IPdfService

## Extends

- [`Service`](../classes/Service.md)

## Accessors

### serviceType

#### Get Signature

> **get** **serviceType**(): [`ServiceType`](../enumerations/ServiceType.md)

##### Returns

[`ServiceType`](../enumerations/ServiceType.md)

#### Inherited from

[`Service`](../classes/Service.md).[`serviceType`](../classes/Service.md#serviceType-1)

#### Defined in

[packages/core/src/types.ts:1279](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1279)

## Methods

### initialize()

> `abstract` **initialize**(`runtime`): `Promise`\<`void`\>

Add abstract initialize method that must be implemented by derived classes

#### Parameters

• **runtime**: [`IAgentRuntime`](IAgentRuntime.md)

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`Service`](../classes/Service.md).[`initialize`](../classes/Service.md#initialize)

#### Defined in

[packages/core/src/types.ts:1284](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1284)

***

### getInstance()

> **getInstance**(): [`IPdfService`](IPdfService.md)

#### Returns

[`IPdfService`](IPdfService.md)

#### Defined in

[packages/core/src/types.ts:1435](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1435)

***

### convertPdfToText()

> **convertPdfToText**(`pdfBuffer`): `Promise`\<`string`\>

#### Parameters

• **pdfBuffer**: `Buffer`

#### Returns

`Promise`\<`string`\>

#### Defined in

[packages/core/src/types.ts:1436](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1436)
