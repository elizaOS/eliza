[@elizaos/core v0.25.8](../index.md) / RAGKnowledgeItem

# Interface: RAGKnowledgeItem

## Properties

### id

> **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Defined in

[packages/core/src/types.ts:1557](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1557)

***

### agentId

> **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Defined in

[packages/core/src/types.ts:1558](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1558)

***

### content

> **content**: `object`

#### text

> **text**: `string`

#### metadata?

> `optional` **metadata**: `object`

##### Index Signature

 \[`key`: `string`\]: `unknown`

#### metadata.isMain?

> `optional` **isMain**: `boolean`

#### metadata.isChunk?

> `optional` **isChunk**: `boolean`

#### metadata.originalId?

> `optional` **originalId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### metadata.chunkIndex?

> `optional` **chunkIndex**: `number`

#### metadata.source?

> `optional` **source**: `string`

#### metadata.type?

> `optional` **type**: `string`

#### metadata.isShared?

> `optional` **isShared**: `boolean`

#### Defined in

[packages/core/src/types.ts:1559](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1559)

***

### embedding?

> `optional` **embedding**: `Float32Array`

#### Defined in

[packages/core/src/types.ts:1572](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1572)

***

### createdAt?

> `optional` **createdAt**: `number`

#### Defined in

[packages/core/src/types.ts:1573](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1573)

***

### similarity?

> `optional` **similarity**: `number`

#### Defined in

[packages/core/src/types.ts:1574](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1574)

***

### score?

> `optional` **score**: `number`

#### Defined in

[packages/core/src/types.ts:1575](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1575)
