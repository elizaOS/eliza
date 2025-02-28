[@elizaos/core v0.25.8](../index.md) / IAgentRuntime

# Interface: IAgentRuntime

## Properties

### agentId

> **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Properties

#### Defined in

[packages/core/src/types.ts:1289](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1289)

***

### serverUrl

> **serverUrl**: `string`

#### Defined in

[packages/core/src/types.ts:1290](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1290)

***

### databaseAdapter

> **databaseAdapter**: [`IDatabaseAdapter`](IDatabaseAdapter.md)

#### Defined in

[packages/core/src/types.ts:1291](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1291)

***

### token

> **token**: `string`

#### Defined in

[packages/core/src/types.ts:1292](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1292)

***

### modelProvider

> **modelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

#### Defined in

[packages/core/src/types.ts:1293](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1293)

***

### imageModelProvider

> **imageModelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

#### Defined in

[packages/core/src/types.ts:1294](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1294)

***

### imageVisionModelProvider

> **imageVisionModelProvider**: [`ModelProviderName`](../enumerations/ModelProviderName.md)

#### Defined in

[packages/core/src/types.ts:1295](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1295)

***

### character

> **character**: [`Character`](../type-aliases/Character.md)

#### Defined in

[packages/core/src/types.ts:1296](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1296)

***

### providers

> **providers**: [`Provider`](Provider.md)[]

#### Defined in

[packages/core/src/types.ts:1297](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1297)

***

### actions

> **actions**: [`Action`](Action.md)[]

#### Defined in

[packages/core/src/types.ts:1298](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1298)

***

### evaluators

> **evaluators**: [`Evaluator`](Evaluator.md)[]

#### Defined in

[packages/core/src/types.ts:1299](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1299)

***

### plugins

> **plugins**: [`Plugin`](../type-aliases/Plugin.md)[]

#### Defined in

[packages/core/src/types.ts:1300](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1300)

***

### fetch()?

> `optional` **fetch**: (`input`, `init`?) => `Promise`\<`Response`\>(`input`, `init`?) => `Promise`\<`Response`\>

[MDN Reference](https://developer.mozilla.org/docs/Web/API/fetch)

#### Parameters

• **input**: `RequestInfo` \| `URL`

• **init?**: `RequestInit`

#### Returns

`Promise`\<`Response`\>

#### Parameters

• **input**: `string` \| `Request` \| `URL`

• **init?**: `RequestInit`

#### Returns

`Promise`\<`Response`\>

#### Defined in

[packages/core/src/types.ts:1302](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1302)

***

### messageManager

> **messageManager**: [`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1304](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1304)

***

### descriptionManager

> **descriptionManager**: [`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1305](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1305)

***

### documentsManager

> **documentsManager**: [`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1306](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1306)

***

### knowledgeManager

> **knowledgeManager**: [`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1307](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1307)

***

### ragKnowledgeManager

> **ragKnowledgeManager**: [`IRAGKnowledgeManager`](IRAGKnowledgeManager.md)

#### Defined in

[packages/core/src/types.ts:1308](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1308)

***

### loreManager

> **loreManager**: [`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1309](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1309)

***

### cacheManager

> **cacheManager**: [`ICacheManager`](ICacheManager.md)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

***

### services

> **services**: `Map`\<[`ServiceType`](../enumerations/ServiceType.md), [`Service`](../classes/Service.md)\>

#### Defined in

[packages/core/src/types.ts:1313](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1313)

***

### clients

> **clients**: [`ClientInstance`](../type-aliases/ClientInstance.md)[]

#### Defined in

[packages/core/src/types.ts:1314](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1314)

## Methods

### initialize()

> **initialize**(): `Promise`\<`void`\>

verifiableInferenceAdapter?: IVerifiableInferenceAdapter | null;

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1318](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1318)

***

### registerMemoryManager()

> **registerMemoryManager**(`manager`): `void`

#### Parameters

• **manager**: [`IMemoryManager`](IMemoryManager.md)

#### Returns

`void`

#### Defined in

[packages/core/src/types.ts:1320](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1320)

***

### getMemoryManager()

> **getMemoryManager**(`name`): [`IMemoryManager`](IMemoryManager.md)

#### Parameters

• **name**: `string`

#### Returns

[`IMemoryManager`](IMemoryManager.md)

#### Defined in

[packages/core/src/types.ts:1322](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1322)

***

### getService()

> **getService**\<`T`\>(`service`): `T`

#### Type Parameters

• **T** *extends* [`Service`](../classes/Service.md)

#### Parameters

• **service**: [`ServiceType`](../enumerations/ServiceType.md)

#### Returns

`T`

#### Defined in

[packages/core/src/types.ts:1324](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1324)

***

### registerService()

> **registerService**(`service`): `void`

#### Parameters

• **service**: [`Service`](../classes/Service.md)

#### Returns

`void`

#### Defined in

[packages/core/src/types.ts:1326](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1326)

***

### getSetting()

> **getSetting**(`key`): `string`

#### Parameters

• **key**: `string`

#### Returns

`string`

#### Defined in

[packages/core/src/types.ts:1328](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1328)

***

### getConversationLength()

> **getConversationLength**(): `number`

Methods

#### Returns

`number`

#### Defined in

[packages/core/src/types.ts:1331](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1331)

***

### processActions()

> **processActions**(`message`, `responses`, `state`?, `callback`?): `Promise`\<`void`\>

#### Parameters

• **message**: [`Memory`](Memory.md)

• **responses**: [`Memory`](Memory.md)[]

• **state?**: [`State`](State.md)

• **callback?**: [`HandlerCallback`](../type-aliases/HandlerCallback.md)

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1333](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1333)

***

### evaluate()

> **evaluate**(`message`, `state`?, `didRespond`?, `callback`?): `Promise`\<`string`[]\>

#### Parameters

• **message**: [`Memory`](Memory.md)

• **state?**: [`State`](State.md)

• **didRespond?**: `boolean`

• **callback?**: [`HandlerCallback`](../type-aliases/HandlerCallback.md)

#### Returns

`Promise`\<`string`[]\>

#### Defined in

[packages/core/src/types.ts:1340](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1340)

***

### ensureParticipantExists()

> **ensureParticipantExists**(`userId`, `roomId`): `Promise`\<`void`\>

#### Parameters

• **userId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1347](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1347)

***

### ensureUserExists()

> **ensureUserExists**(`userId`, `userName`, `name`, `source`): `Promise`\<`void`\>

#### Parameters

• **userId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **userName**: `string`

• **name**: `string`

• **source**: `string`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1349](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1349)

***

### registerAction()

> **registerAction**(`action`): `void`

#### Parameters

• **action**: [`Action`](Action.md)

#### Returns

`void`

#### Defined in

[packages/core/src/types.ts:1356](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1356)

***

### ensureConnection()

> **ensureConnection**(`userId`, `roomId`, `userName`?, `userScreenName`?, `source`?): `Promise`\<`void`\>

#### Parameters

• **userId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **userName?**: `string`

• **userScreenName?**: `string`

• **source?**: `string`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1358](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1358)

***

### ensureParticipantInRoom()

> **ensureParticipantInRoom**(`userId`, `roomId`): `Promise`\<`void`\>

#### Parameters

• **userId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1366](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1366)

***

### ensureRoomExists()

> **ensureRoomExists**(`roomId`): `Promise`\<`void`\>

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:1368](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1368)

***

### composeState()

> **composeState**(`message`, `additionalKeys`?): `Promise`\<[`State`](State.md)\>

#### Parameters

• **message**: [`Memory`](Memory.md)

• **additionalKeys?**

#### Returns

`Promise`\<[`State`](State.md)\>

#### Defined in

[packages/core/src/types.ts:1370](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1370)

***

### updateRecentMessageState()

> **updateRecentMessageState**(`state`): `Promise`\<[`State`](State.md)\>

#### Parameters

• **state**: [`State`](State.md)

#### Returns

`Promise`\<[`State`](State.md)\>

#### Defined in

[packages/core/src/types.ts:1375](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1375)
