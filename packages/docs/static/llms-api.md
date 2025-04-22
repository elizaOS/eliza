This file is a merged representation of a subset of the codebase, containing specifically included files, combined into a single document by Repomix.

# File Summary

## Purpose

This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format

The content is organized as follows:

1. This summary section
2. Repository information
3. Directory structure
4. Multiple file entries, each consisting of:
   a. A header with the file path (## File: path/to/file)
   b. The full contents of the file in a code block

## Usage Guidelines

- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes

- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Only files matching these patterns are included: packages/docs/api/\*_/_.md
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

## Additional Info

# Directory Structure

```
packages/
  docs/
    api/
      classes/
        AgentRuntime.md
        DatabaseAdapter.md
        Service.md
      enumerations/
        EventType.md
        PlatformPrefix.md
        SOCKET_MESSAGE_TYPE.md
      functions/
        addHeader.md
        asUUID.md
        cleanJsonResponse.md
        composeActionExamples.md
        composePrompt.md
        composePromptFromState.md
        composeRandomUser.md
        createMessageMemory.md
        createServiceError.md
        createSettingFromConfig.md
        createUniqueUuid.md
        decryptedCharacter.md
        decryptObjectValues.md
        decryptStringValue.md
        encryptedCharacter.md
        encryptObjectValues.md
        encryptStringValue.md
        extractAttributes.md
        findEntityByName.md
        findWorldsForOwner.md
        formatActionNames.md
        formatActions.md
        formatEntities.md
        formatMessages.md
        getBrowserService.md
        getEntityDetails.md
        getFileService.md
        getMemoryText.md
        getPdfService.md
        getSalt.md
        getTypedService.md
        getUserServerRole.md
        getVideoService.md
        getWavHeader.md
        getWorldSettings.md
        initializeOnboarding.md
        isCustomMetadata.md
        isDescriptionMetadata.md
        isDocumentMemory.md
        isDocumentMetadata.md
        isFragmentMemory.md
        isFragmentMetadata.md
        isMessageMetadata.md
        normalizeJsonString.md
        parseBooleanFromText.md
        parseJsonArrayFromText.md
        parseJSONObjectFromText.md
        prependWavHeader.md
        saltSettingValue.md
        saltWorldSettings.md
        stringToUuid.md
        trimTokens.md
        truncateToCompleteSentence.md
        unsaltSettingValue.md
        unsaltWorldSettings.md
        updateWorldSettings.md
        validateUuid.md
      interfaces/
        Action.md
        ActionEventPayload.md
        ActionExample.md
        AudioProcessingParams.md
        BaseMetadata.md
        BaseModelParams.md
        Character.md
        Content.md
        ControlMessage.md
        DetokenizeTextParams.md
        EmbeddingSearchResult.md
        EnhancedState.md
        Entity.md
        EntityPayload.md
        EvaluationExample.md
        Evaluator.md
        EvaluatorEventPayload.md
        EventPayload.md
        EventPayloadMap.md
        IDatabaseAdapter.md
        ImageDescriptionParams.md
        ImageGenerationParams.md
        InvokePayload.md
        Log.md
        Memory.md
        MemoryRetrievalOptions.md
        MemorySearchOptions.md
        MessageExample.md
        MessageMemory.md
        MessagePayload.md
        ModelEventPayload.md
        ModelParamsMap.md
        ModelResultMap.md
        MultiRoomMemoryOptions.md
        ObjectGenerationParams.md
        Participant.md
        Plugin.md
        Provider.md
        Relationship.md
        RunEventPayload.md
        RuntimeSettings.md
        ServerOwnershipState.md
        ServiceError.md
        State.md
        TextEmbeddingParams.md
        TextGenerationParams.md
        TextToSpeechParams.md
        TokenizeTextParams.md
        TranscriptionParams.md
        TypedService.md
        UnifiedMemoryOptions.md
        UnifiedSearchOptions.md
        VideoProcessingParams.md
        WorldPayload.md
      type-aliases/
        EventHandler.md
        Handler.md
        HandlerCallback.md
        JSONSchema.md
        Media.md
        MemoryTypeAlias.md
        MessageReceivedHandlerParams.md
        StateValue.md
        UUID.md
        Validator.md
      variables/
        ModelType.md
      index.md
```

# Files

## File: packages/docs/api/classes/AgentRuntime.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / AgentRuntime

# Class: AgentRuntime

Represents the runtime environment for an agent.

## Implements

## Implements

- `IAgentRuntime`

## Accessors

### db

#### Get Signature

> **get** **db**(): `any`

Database instance

##### Returns

`any`

#### Implementation of

`IAgentRuntime.db`

#### Defined in

[packages/core/src/runtime.ts:1475](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1475)

## Methods

### registerPlugin()

> **registerPlugin**(`plugin`): `Promise`\<`void`\>

Registers a plugin with the runtime and initializes its components

#### Parameters

• **plugin**: [`Plugin`](../interfaces/Plugin.md)

The plugin to register

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.registerPlugin`

#### Defined in

[packages/core/src/runtime.ts:189](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L189)

---

### getConversationLength()

> **getConversationLength**(): `number`

Get the number of messages that are kept in the conversation buffer.

#### Returns

`number`

The number of recent messages to be kept in memory.

#### Implementation of

`IAgentRuntime.getConversationLength`

#### Defined in

[packages/core/src/runtime.ts:632](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L632)

---

### registerProvider()

> **registerProvider**(`provider`): `void`

Register a provider for the agent to use.

#### Parameters

• **provider**: [`Provider`](../interfaces/Provider.md)

The provider to register.

#### Returns

`void`

#### Implementation of

`IAgentRuntime.registerProvider`

#### Defined in

[packages/core/src/runtime.ts:651](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L651)

---

### registerAction()

> **registerAction**(`action`): `void`

Register an action for the agent to perform.

#### Parameters

• **action**: [`Action`](../interfaces/Action.md)

The action to register.

#### Returns

`void`

#### Implementation of

`IAgentRuntime.registerAction`

#### Defined in

[packages/core/src/runtime.ts:660](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L660)

---

### registerEvaluator()

> **registerEvaluator**(`evaluator`): `void`

Register an evaluator to assess and guide the agent's responses.

#### Parameters

• **evaluator**: [`Evaluator`](../interfaces/Evaluator.md)

The evaluator to register.

#### Returns

`void`

#### Implementation of

`IAgentRuntime.registerEvaluator`

#### Defined in

[packages/core/src/runtime.ts:681](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L681)

---

### registerContextProvider()

> **registerContextProvider**(`provider`): `void`

Register a context provider to provide context for message generation.

#### Parameters

• **provider**: [`Provider`](../interfaces/Provider.md)

The context provider to register.

#### Returns

`void`

#### Defined in

[packages/core/src/runtime.ts:689](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L689)

---

### processActions()

> **processActions**(`message`, `responses`, `state`?, `callback`?): `Promise`\<`void`\>

Process the actions of a message.

#### Parameters

• **message**: [`Memory`](../interfaces/Memory.md)

The message to process.

• **responses**: [`Memory`](../interfaces/Memory.md)[]

The array of response memories to process actions from.

• **state?**: [`State`](../interfaces/State.md)

Optional state object for the action processing.

• **callback?**: [`HandlerCallback`](../type-aliases/HandlerCallback.md)

Optional callback handler for action results.

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.processActions`

#### Defined in

[packages/core/src/runtime.ts:700](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L700)

---

### evaluate()

> **evaluate**(`message`, `state`, `didRespond`?, `callback`?, `responses`?): `Promise`\<[`Evaluator`](../interfaces/Evaluator.md)[]\>

Evaluate the message and state using the registered evaluators.

#### Parameters

• **message**: [`Memory`](../interfaces/Memory.md)

The message to evaluate.

• **state**: [`State`](../interfaces/State.md)

The state of the agent.

• **didRespond?**: `boolean`

Whether the agent responded to the message.~

• **callback?**: [`HandlerCallback`](../type-aliases/HandlerCallback.md)

The handler callback

• **responses?**: [`Memory`](../interfaces/Memory.md)[]

#### Returns

`Promise`\<[`Evaluator`](../interfaces/Evaluator.md)[]\>

The results of the evaluation.

#### Implementation of

`IAgentRuntime.evaluate`

#### Defined in

[packages/core/src/runtime.ts:796](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L796)

---

### ensureParticipantInRoom()

> **ensureParticipantInRoom**(`entityId`, `roomId`): `Promise`\<`void`\>

Ensures a participant is added to a room, checking that the entity exists first

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.ensureParticipantInRoom`

#### Defined in

[packages/core/src/runtime.ts:999](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L999)

---

### ensureWorldExists()

> **ensureWorldExists**(`__namedParameters`): `Promise`\<`void`\>

Ensure the existence of a world.

#### Parameters

• **\_\_namedParameters**: `World`

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.ensureWorldExists`

#### Defined in

[packages/core/src/runtime.ts:1054](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1054)

---

### ensureRoomExists()

> **ensureRoomExists**(`entityId`): `Promise`\<`void`\>

Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
and agent are added as participants. The room ID is returned.

#### Parameters

• **entityId**: `Room`

The user ID to create a room with.

#### Returns

`Promise`\<`void`\>

The room ID of the room between the agent and the user.

#### Throws

An error if the room cannot be created.

#### Implementation of

`IAgentRuntime.ensureRoomExists`

#### Defined in

[packages/core/src/runtime.ts:1090](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1090)

---

### composeState()

> **composeState**(`message`, `filterList`, `includeList`): `Promise`\<[`State`](../interfaces/State.md)\>

Composes the agent's state by gathering data from enabled providers.

#### Parameters

• **message**: [`Memory`](../interfaces/Memory.md)

The message to use as context for state composition

• **filterList**: `string`[] = `null`

Optional list of provider names to include, filtering out all others

• **includeList**: `string`[] = `null`

Optional list of private provider names to include that would otherwise be filtered out

#### Returns

`Promise`\<[`State`](../interfaces/State.md)\>

A State object containing provider data, values, and text

#### Implementation of

`IAgentRuntime.composeState`

#### Defined in

[packages/core/src/runtime.ts:1115](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1115)

---

### useModel()

> **useModel**\<`T`, `R`\>(`modelType`, `params`): `Promise`\<`R`\>

Use a model with strongly typed parameters and return values based on model type

#### Type Parameters

• **T** _extends_ `string`

The model type to use

• **R** = [`ModelResultMap`](../interfaces/ModelResultMap.md)\[`T`\]

The expected return type, defaults to the type defined in ModelResultMap[T]

#### Parameters

• **modelType**: `T`

The type of model to use

• **params**: `any`

The parameters for the model, typed based on model type

#### Returns

`Promise`\<`R`\>

- The model result, typed based on the provided generic type parameter

#### Implementation of

`IAgentRuntime.useModel`

#### Defined in

[packages/core/src/runtime.ts:1290](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1290)

---

### getTaskWorker()

> **getTaskWorker**(`name`): `TaskWorker`

Get a task worker by name

#### Parameters

• **name**: `string`

#### Returns

`TaskWorker`

#### Implementation of

`IAgentRuntime.getTaskWorker`

#### Defined in

[packages/core/src/runtime.ts:1469](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1469)

---

### init()

> **init**(): `Promise`\<`void`\>

Initialize database connection

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.init`

#### Defined in

[packages/core/src/runtime.ts:1479](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1479)

---

### close()

> **close**(): `Promise`\<`void`\>

Close database connection

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.close`

#### Defined in

[packages/core/src/runtime.ts:1483](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1483)

---

### getAgents()

> **getAgents**(): `Promise`\<`Agent`[]\>

Get all agents

#### Returns

`Promise`\<`Agent`[]\>

#### Implementation of

`IAgentRuntime.getAgents`

#### Defined in

[packages/core/src/runtime.ts:1491](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1491)

---

### getEntityById()

> **getEntityById**(`entityId`): `Promise`\<[`Entity`](../interfaces/Entity.md)\>

Get entity by ID

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<[`Entity`](../interfaces/Entity.md)\>

#### Implementation of

`IAgentRuntime.getEntityById`

#### Defined in

[packages/core/src/runtime.ts:1511](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1511)

---

### getEntitiesForRoom()

> **getEntitiesForRoom**(`roomId`, `includeComponents`?): `Promise`\<[`Entity`](../interfaces/Entity.md)[]\>

Get entities for room

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **includeComponents?**: `boolean`

#### Returns

`Promise`\<[`Entity`](../interfaces/Entity.md)[]\>

#### Implementation of

`IAgentRuntime.getEntitiesForRoom`

#### Defined in

[packages/core/src/runtime.ts:1515](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1515)

---

### createEntity()

> **createEntity**(`entity`): `Promise`\<`boolean`\>

Create new entity

#### Parameters

• **entity**: [`Entity`](../interfaces/Entity.md)

#### Returns

`Promise`\<`boolean`\>

#### Implementation of

`IAgentRuntime.createEntity`

#### Defined in

[packages/core/src/runtime.ts:1519](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1519)

---

### updateEntity()

> **updateEntity**(`entity`): `Promise`\<`void`\>

Update entity

#### Parameters

• **entity**: [`Entity`](../interfaces/Entity.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.updateEntity`

#### Defined in

[packages/core/src/runtime.ts:1526](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1526)

---

### getComponent()

> **getComponent**(`entityId`, `type`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`\>

Get component by ID

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **type**: `string`

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`Component`\>

#### Implementation of

`IAgentRuntime.getComponent`

#### Defined in

[packages/core/src/runtime.ts:1530](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1530)

---

### getComponents()

> **getComponents**(`entityId`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`[]\>

Get all components for an entity

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`Component`[]\>

#### Implementation of

`IAgentRuntime.getComponents`

#### Defined in

[packages/core/src/runtime.ts:1539](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1539)

---

### createComponent()

> **createComponent**(`component`): `Promise`\<`boolean`\>

Create component

#### Parameters

• **component**: `Component`

#### Returns

`Promise`\<`boolean`\>

#### Implementation of

`IAgentRuntime.createComponent`

#### Defined in

[packages/core/src/runtime.ts:1543](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1543)

---

### updateComponent()

> **updateComponent**(`component`): `Promise`\<`void`\>

Update component

#### Parameters

• **component**: `Component`

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.updateComponent`

#### Defined in

[packages/core/src/runtime.ts:1547](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1547)

---

### deleteComponent()

> **deleteComponent**(`componentId`): `Promise`\<`void`\>

Delete component

#### Parameters

• **componentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Implementation of

`IAgentRuntime.deleteComponent`

#### Defined in

[packages/core/src/runtime.ts:1551](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1551)

---

### getMemories()

> **getMemories**(`params`): `Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Get memories matching criteria

#### Parameters

• **params**

• **params.entityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.agentId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.count?**: `number`

• **params.unique?**: `boolean`

• **params.tableName**: `string`

• **params.start?**: `number`

• **params.end?**: `number`

#### Returns

`Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

#### Implementation of

`IAgentRuntime.getMemories`

#### Defined in

[packages/core/src/runtime.ts:1582](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1582)

---

### createRelationship()

> **createRelationship**(`params`): `Promise`\<`boolean`\>

Creates a new relationship between two entities.

#### Parameters

• **params**

Object containing the relationship details

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

• **params.metadata?**

#### Returns

`Promise`\<`boolean`\>

Promise resolving to boolean indicating success

#### Implementation of

`IAgentRuntime.createRelationship`

#### Defined in

[packages/core/src/runtime.ts:1745](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1745)

---

### updateRelationship()

> **updateRelationship**(`relationship`): `Promise`\<`void`\>

Updates an existing relationship between two entities.

#### Parameters

• **relationship**: [`Relationship`](../interfaces/Relationship.md)

The relationship object with updated data

#### Returns

`Promise`\<`void`\>

Promise resolving to void

#### Implementation of

`IAgentRuntime.updateRelationship`

#### Defined in

[packages/core/src/runtime.ts:1754](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1754)

---

### getRelationship()

> **getRelationship**(`params`): `Promise`\<[`Relationship`](../interfaces/Relationship.md)\>

Retrieves a relationship between two entities if it exists.

#### Parameters

• **params**

Object containing the entity IDs and agent ID

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<[`Relationship`](../interfaces/Relationship.md)\>

Promise resolving to the Relationship object or null if not found

#### Implementation of

`IAgentRuntime.getRelationship`

#### Defined in

[packages/core/src/runtime.ts:1758](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1758)

---

### getRelationships()

> **getRelationships**(`params`): `Promise`\<[`Relationship`](../interfaces/Relationship.md)[]\>

Retrieves all relationships for a specific entity.

#### Parameters

• **params**

Object containing the user ID, agent ID and optional tags to filter by

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

#### Returns

`Promise`\<[`Relationship`](../interfaces/Relationship.md)[]\>

Promise resolving to an array of Relationship objects

#### Implementation of

`IAgentRuntime.getRelationships`

#### Defined in

[packages/core/src/runtime.ts:1765](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1765)

---

### sendControlMessage()

> **sendControlMessage**(`params`): `Promise`\<`void`\>

Sends a control message to the frontend to enable or disable input

#### Parameters

• **params**

Parameters for the control message

• **params.roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The ID of the room to send the control message to

• **params.action**: `"disable_input"` \| `"enable_input"`

The action to perform

• **params.target?**: `string`

Optional target element identifier

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/runtime.ts:1841](https://github.com/elizaOS/eliza/blob/main/packages/core/src/runtime.ts#L1841)
```

## File: packages/docs/api/classes/DatabaseAdapter.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / DatabaseAdapter

# Class: `abstract` DatabaseAdapter\<DB\>

Database adapter class to be extended by individual database adapters.

## Implements

## Type Parameters

• **DB** = `unknown`

The type of the database instance.

## Implements

- [`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md)

## Properties

### db

> **db**: `DB`

The database instance.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`db`](../interfaces/IDatabaseAdapter.md#db)

#### Defined in

[packages/core/src/database.ts:32](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L32)

## Methods

### init()

> `abstract` **init**(): `Promise`\<`void`\>

Initialize the database adapter.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when initialization is complete.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`init`](../interfaces/IDatabaseAdapter.md#init)

#### Defined in

[packages/core/src/database.ts:38](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L38)

---

### close()

> `abstract` **close**(): `Promise`\<`void`\>

Optional close method for the database adapter.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when closing is complete.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`close`](../interfaces/IDatabaseAdapter.md#close)

#### Defined in

[packages/core/src/database.ts:44](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L44)

---

### getEntityById()

> `abstract` **getEntityById**(`entityId`): `Promise`\<[`Entity`](../interfaces/Entity.md)\>

Retrieves an account by its ID.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the user account to retrieve.

#### Returns

`Promise`\<[`Entity`](../interfaces/Entity.md)\>

A Promise that resolves to the Entity object or null if not found.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getEntityById`](../interfaces/IDatabaseAdapter.md#getEntityById)

#### Defined in

[packages/core/src/database.ts:51](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L51)

---

### getEntitiesForRoom()

> `abstract` **getEntitiesForRoom**(`roomId`, `includeComponents`?): `Promise`\<[`Entity`](../interfaces/Entity.md)[]\>

Get entities for room

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **includeComponents?**: `boolean`

#### Returns

`Promise`\<[`Entity`](../interfaces/Entity.md)[]\>

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getEntitiesForRoom`](../interfaces/IDatabaseAdapter.md#getEntitiesForRoom)

#### Defined in

[packages/core/src/database.ts:53](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L53)

---

### createEntity()

> `abstract` **createEntity**(`entity`): `Promise`\<`boolean`\>

Creates a new entity in the database.

#### Parameters

• **entity**: [`Entity`](../interfaces/Entity.md)

The entity object to create.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves when the account creation is complete.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`createEntity`](../interfaces/IDatabaseAdapter.md#createEntity)

#### Defined in

[packages/core/src/database.ts:60](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L60)

---

### updateEntity()

> `abstract` **updateEntity**(`entity`): `Promise`\<`void`\>

Updates an existing entity in the database.

#### Parameters

• **entity**: [`Entity`](../interfaces/Entity.md)

The entity object with updated properties.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the account update is complete.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`updateEntity`](../interfaces/IDatabaseAdapter.md#updateEntity)

#### Defined in

[packages/core/src/database.ts:67](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L67)

---

### getComponent()

> `abstract` **getComponent**(`entityId`, `type`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`\>

Retrieves a single component by entity ID and type.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the entity the component belongs to

• **type**: `string`

The type identifier for the component

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional UUID of the world the component belongs to

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional UUID of the source entity

#### Returns

`Promise`\<`Component`\>

Promise resolving to the Component if found, null otherwise

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getComponent`](../interfaces/IDatabaseAdapter.md#getComponent)

#### Defined in

[packages/core/src/database.ts:77](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L77)

---

### getComponents()

> `abstract` **getComponents**(`entityId`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`[]\>

Retrieves all components for an entity.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the entity to get components for

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional UUID of the world to filter components by

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional UUID of the source entity to filter by

#### Returns

`Promise`\<`Component`[]\>

Promise resolving to array of Component objects

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getComponents`](../interfaces/IDatabaseAdapter.md#getComponents)

#### Defined in

[packages/core/src/database.ts:91](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L91)

---

### createComponent()

> `abstract` **createComponent**(`component`): `Promise`\<`boolean`\>

Creates a new component in the database.

#### Parameters

• **component**: `Component`

The component object to create

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if creation was successful

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`createComponent`](../interfaces/IDatabaseAdapter.md#createComponent)

#### Defined in

[packages/core/src/database.ts:102](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L102)

---

### updateComponent()

> `abstract` **updateComponent**(`component`): `Promise`\<`void`\>

Updates an existing component in the database.

#### Parameters

• **component**: `Component`

The component object with updated properties

#### Returns

`Promise`\<`void`\>

Promise that resolves when the update is complete

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`updateComponent`](../interfaces/IDatabaseAdapter.md#updateComponent)

#### Defined in

[packages/core/src/database.ts:109](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L109)

---

### deleteComponent()

> `abstract` **deleteComponent**(`componentId`): `Promise`\<`void`\>

Deletes a component from the database.

#### Parameters

• **componentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the component to delete

#### Returns

`Promise`\<`void`\>

Promise that resolves when the deletion is complete

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`deleteComponent`](../interfaces/IDatabaseAdapter.md#deleteComponent)

#### Defined in

[packages/core/src/database.ts:116](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L116)

---

### getMemories()

> `abstract` **getMemories**(`params`): `Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Retrieves memories based on the specified parameters.

#### Parameters

• **params**

An object containing parameters for the memory retrieval.

• **params.entityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.agentId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.count?**: `number`

• **params.unique?**: `boolean`

• **params.tableName**: `string`

• **params.start?**: `number`

• **params.end?**: `number`

#### Returns

`Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

A Promise that resolves to an array of Memory objects.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getMemories`](../interfaces/IDatabaseAdapter.md#getMemories)

#### Defined in

[packages/core/src/database.ts:123](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L123)

---

### getMemoriesByIds()

> `abstract` **getMemoriesByIds**(`memoryIds`, `tableName`?): `Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Retrieves multiple memories by their IDs

#### Parameters

• **memoryIds**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]

Array of UUIDs of the memories to retrieve

• **tableName?**: `string`

Optional table name to filter memories by type

#### Returns

`Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Promise resolving to array of Memory objects

#### Implementation of

`IDatabaseAdapter.getMemoriesByIds`

#### Defined in

[packages/core/src/database.ts:148](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L148)

---

### getCachedEmbeddings()

> `abstract` **getCachedEmbeddings**(`params`): `Promise`\<`object`[]\>

Retrieves cached embeddings based on the specified query parameters.

#### Parameters

• **params**

An object containing parameters for the embedding retrieval.

• **params.query_table_name**: `string`

• **params.query_threshold**: `number`

• **params.query_input**: `string`

• **params.query_field_name**: `string`

• **params.query_field_sub_name**: `string`

• **params.query_match_count**: `number`

#### Returns

`Promise`\<`object`[]\>

A Promise that resolves to an array of objects containing embeddings and levenshtein scores.

#### Implementation of

`IDatabaseAdapter.getCachedEmbeddings`

#### Defined in

[packages/core/src/database.ts:155](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L155)

---

### log()

> `abstract` **log**(`params`): `Promise`\<`void`\>

Logs an event or action with the specified details.

#### Parameters

• **params**

An object containing parameters for the log entry.

• **params.body**

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.type**: `string`

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the log entry has been saved.

#### Implementation of

`IDatabaseAdapter.log`

#### Defined in

[packages/core/src/database.ts:181](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L181)

---

### getLogs()

> `abstract` **getLogs**(`params`): `Promise`\<[`Log`](../interfaces/Log.md)[]\>

Retrieves logs based on the specified parameters.

#### Parameters

• **params**

An object containing parameters for the log retrieval.

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.type?**: `string`

• **params.count?**: `number`

• **params.offset?**: `number`

#### Returns

`Promise`\<[`Log`](../interfaces/Log.md)[]\>

A Promise that resolves to an array of Log objects.

#### Implementation of

`IDatabaseAdapter.getLogs`

#### Defined in

[packages/core/src/database.ts:193](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L193)

---

### deleteLog()

> `abstract` **deleteLog**(`logId`): `Promise`\<`void`\>

Deletes a log from the database.

#### Parameters

• **logId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the log to delete.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the log has been deleted.

#### Implementation of

`IDatabaseAdapter.deleteLog`

#### Defined in

[packages/core/src/database.ts:206](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L206)

---

### searchMemories()

> `abstract` **searchMemories**(`params`): `Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Searches for memories based on embeddings and other specified parameters.

#### Parameters

• **params**

An object containing parameters for the memory search.

• **params.tableName**: `string`

• **params.roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.embedding**: `number`[]

• **params.match_threshold**: `number`

• **params.count**: `number`

• **params.unique**: `boolean`

#### Returns

`Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

A Promise that resolves to an array of Memory objects.

#### Implementation of

`IDatabaseAdapter.searchMemories`

#### Defined in

[packages/core/src/database.ts:213](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L213)

---

### createMemory()

> `abstract` **createMemory**(`memory`, `tableName`, `unique`?): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

Creates a new memory in the database.

#### Parameters

• **memory**: [`Memory`](../interfaces/Memory.md)

The memory object to create.

• **tableName**: `string`

The table where the memory should be stored.

• **unique?**: `boolean`

Indicates if the memory should be unique.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

A Promise that resolves when the memory has been created.

#### Implementation of

`IDatabaseAdapter.createMemory`

#### Defined in

[packages/core/src/database.ts:229](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L229)

---

### updateMemory()

> `abstract` **updateMemory**(`memory`): `Promise`\<`boolean`\>

Updates an existing memory in the database.

#### Parameters

• **memory**: `Partial`\<[`Memory`](../interfaces/Memory.md)\> & `object`

The memory object with updated content and optional embedding

#### Returns

`Promise`\<`boolean`\>

Promise resolving to boolean indicating success

#### Implementation of

`IDatabaseAdapter.updateMemory`

#### Defined in

[packages/core/src/database.ts:236](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L236)

---

### deleteMemory()

> `abstract` **deleteMemory**(`memoryId`): `Promise`\<`void`\>

Removes a specific memory from the database.

#### Parameters

• **memoryId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the memory to remove.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the memory has been removed.

#### Implementation of

`IDatabaseAdapter.deleteMemory`

#### Defined in

[packages/core/src/database.ts:245](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L245)

---

### deleteAllMemories()

> `abstract` **deleteAllMemories**(`roomId`, `tableName`): `Promise`\<`void`\>

Removes all memories associated with a specific room.

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room whose memories should be removed.

• **tableName**: `string`

The table from which the memories should be removed.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when all memories have been removed.

#### Implementation of

`IDatabaseAdapter.deleteAllMemories`

#### Defined in

[packages/core/src/database.ts:253](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L253)

---

### countMemories()

> `abstract` **countMemories**(`roomId`, `unique`?, `tableName`?): `Promise`\<`number`\>

Counts the number of memories in a specific room.

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room for which to count memories.

• **unique?**: `boolean`

Specifies whether to count only unique memories.

• **tableName?**: `string`

Optional table name to count memories from.

#### Returns

`Promise`\<`number`\>

A Promise that resolves to the number of memories.

#### Implementation of

`IDatabaseAdapter.countMemories`

#### Defined in

[packages/core/src/database.ts:262](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L262)

---

### getWorld()

> `abstract` **getWorld**(`id`): `Promise`\<`World`\>

Retrieves a world by its ID.

#### Parameters

• **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the world to retrieve.

#### Returns

`Promise`\<`World`\>

A Promise that resolves to the World object or null if not found.

#### Implementation of

`IDatabaseAdapter.getWorld`

#### Defined in

[packages/core/src/database.ts:269](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L269)

---

### getAllWorlds()

> `abstract` **getAllWorlds**(): `Promise`\<`World`[]\>

Retrieves all worlds for an agent.

#### Returns

`Promise`\<`World`[]\>

A Promise that resolves to an array of World objects.

#### Implementation of

`IDatabaseAdapter.getAllWorlds`

#### Defined in

[packages/core/src/database.ts:275](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L275)

---

### createWorld()

> `abstract` **createWorld**(`world`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

Creates a new world in the database.

#### Parameters

• **world**: `World`

The world object to create.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

A Promise that resolves to the UUID of the created world.

#### Implementation of

`IDatabaseAdapter.createWorld`

#### Defined in

[packages/core/src/database.ts:282](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L282)

---

### updateWorld()

> `abstract` **updateWorld**(`world`): `Promise`\<`void`\>

Updates an existing world in the database.

#### Parameters

• **world**: `World`

The world object with updated properties.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the world has been updated.

#### Implementation of

`IDatabaseAdapter.updateWorld`

#### Defined in

[packages/core/src/database.ts:289](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L289)

---

### removeWorld()

> `abstract` **removeWorld**(`id`): `Promise`\<`void`\>

Removes a specific world from the database.

#### Parameters

• **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the world to remove.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the world has been removed.

#### Defined in

[packages/core/src/database.ts:296](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L296)

---

### getRoom()

> `abstract` **getRoom**(`roomId`): `Promise`\<`Room`\>

Retrieves the room ID for a given room, if it exists.

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room to retrieve.

#### Returns

`Promise`\<`Room`\>

A Promise that resolves to the room ID or null if not found.

#### Implementation of

`IDatabaseAdapter.getRoom`

#### Defined in

[packages/core/src/database.ts:303](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L303)

---

### getRooms()

> `abstract` **getRooms**(`worldId`): `Promise`\<`Room`[]\>

Retrieves all rooms for a given world.

#### Parameters

• **worldId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the world to retrieve rooms for.

#### Returns

`Promise`\<`Room`[]\>

A Promise that resolves to an array of Room objects.

#### Implementation of

`IDatabaseAdapter.getRooms`

#### Defined in

[packages/core/src/database.ts:310](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L310)

---

### createRoom()

> `abstract` **createRoom**(`roomId`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

Creates a new room with an optional specified ID.

#### Parameters

• **roomId**: `Room`

Optional UUID to assign to the new room.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

A Promise that resolves to the UUID of the created room.

#### Implementation of

`IDatabaseAdapter.createRoom`

#### Defined in

[packages/core/src/database.ts:317](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L317)

---

### updateRoom()

> `abstract` **updateRoom**(`room`): `Promise`\<`void`\>

Updates a specific room in the database.

#### Parameters

• **room**: `Room`

The room object with updated properties.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the room has been updated.

#### Implementation of

`IDatabaseAdapter.updateRoom`

#### Defined in

[packages/core/src/database.ts:324](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L324)

---

### deleteRoom()

> `abstract` **deleteRoom**(`roomId`): `Promise`\<`void`\>

Removes a specific room from the database.

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room to remove.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the room has been removed.

#### Implementation of

`IDatabaseAdapter.deleteRoom`

#### Defined in

[packages/core/src/database.ts:331](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L331)

---

### getRoomsForParticipant()

> `abstract` **getRoomsForParticipant**(`entityId`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

Retrieves room IDs for which a specific user is a participant.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the user.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

A Promise that resolves to an array of room IDs.

#### Implementation of

`IDatabaseAdapter.getRoomsForParticipant`

#### Defined in

[packages/core/src/database.ts:338](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L338)

---

### getRoomsForParticipants()

> `abstract` **getRoomsForParticipants**(`userIds`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

Retrieves room IDs for which specific users are participants.

#### Parameters

• **userIds**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]

An array of UUIDs of the users.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

A Promise that resolves to an array of room IDs.

#### Implementation of

`IDatabaseAdapter.getRoomsForParticipants`

#### Defined in

[packages/core/src/database.ts:345](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L345)

---

### addParticipant()

> `abstract` **addParticipant**(`entityId`, `roomId`): `Promise`\<`boolean`\>

Adds a user as a participant to a specific room.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the user to add as a participant.

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room to which the user will be added.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure.

#### Implementation of

`IDatabaseAdapter.addParticipant`

#### Defined in

[packages/core/src/database.ts:353](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L353)

---

### removeParticipant()

> `abstract` **removeParticipant**(`entityId`, `roomId`): `Promise`\<`boolean`\>

Removes a user as a participant from a specific room.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the user to remove as a participant.

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room from which the user will be removed.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure.

#### Implementation of

`IDatabaseAdapter.removeParticipant`

#### Defined in

[packages/core/src/database.ts:361](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L361)

---

### getParticipantsForEntity()

> `abstract` **getParticipantsForEntity**(`entityId`): `Promise`\<[`Participant`](../interfaces/Participant.md)[]\>

Retrieves participants associated with a specific account.

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the account.

#### Returns

`Promise`\<[`Participant`](../interfaces/Participant.md)[]\>

A Promise that resolves to an array of Participant objects.

#### Implementation of

`IDatabaseAdapter.getParticipantsForEntity`

#### Defined in

[packages/core/src/database.ts:368](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L368)

---

### getParticipantsForRoom()

> `abstract` **getParticipantsForRoom**(`roomId`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

Retrieves participants for a specific room.

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the room for which to retrieve participants.

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`[]\>

A Promise that resolves to an array of UUIDs representing the participants.

#### Implementation of

`IDatabaseAdapter.getParticipantsForRoom`

#### Defined in

[packages/core/src/database.ts:375](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L375)

---

### createRelationship()

> `abstract` **createRelationship**(`params`): `Promise`\<`boolean`\>

Creates a new relationship between two users.

#### Parameters

• **params**

Object containing the relationship details including entity IDs, agent ID, optional tags and metadata

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

• **params.metadata?**: `Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure of the creation.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`createRelationship`](../interfaces/IDatabaseAdapter.md#createRelationship)

#### Defined in

[packages/core/src/database.ts:393](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L393)

---

### getRelationship()

> `abstract` **getRelationship**(`params`): `Promise`\<[`Relationship`](../interfaces/Relationship.md)\>

Retrieves a relationship between two users if it exists.

#### Parameters

• **params**

Object containing the entity IDs and agent ID

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<[`Relationship`](../interfaces/Relationship.md)\>

A Promise that resolves to the Relationship object or null if not found.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getRelationship`](../interfaces/IDatabaseAdapter.md#getRelationship)

#### Defined in

[packages/core/src/database.ts:405](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L405)

---

### getRelationships()

> `abstract` **getRelationships**(`params`): `Promise`\<[`Relationship`](../interfaces/Relationship.md)[]\>

Retrieves all relationships for a specific user.

#### Parameters

• **params**

Object containing the user ID, agent ID and optional tags to filter by

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

#### Returns

`Promise`\<[`Relationship`](../interfaces/Relationship.md)[]\>

A Promise that resolves to an array of Relationship objects.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getRelationships`](../interfaces/IDatabaseAdapter.md#getRelationships)

#### Defined in

[packages/core/src/database.ts:415](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L415)

---

### updateRelationship()

> `abstract` **updateRelationship**(`params`): `Promise`\<`void`\>

Updates an existing relationship between two users.

#### Parameters

• **params**

Object containing the relationship details to update including entity IDs, agent ID, optional tags and metadata

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

• **params.metadata?**: `Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`void`\>

A Promise that resolves to a boolean indicating success or failure of the update.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`updateRelationship`](../interfaces/IDatabaseAdapter.md#updateRelationship)

#### Defined in

[packages/core/src/database.ts:422](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L422)

---

### getAgent()

> `abstract` **getAgent**(`agentId`): `Promise`\<`Agent`\>

Retrieves an agent by its ID.

#### Parameters

• **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the agent to retrieve.

#### Returns

`Promise`\<`Agent`\>

A Promise that resolves to the Agent object or null if not found.

#### Implementation of

`IDatabaseAdapter.getAgent`

#### Defined in

[packages/core/src/database.ts:434](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L434)

---

### getAgents()

> `abstract` **getAgents**(): `Promise`\<`Agent`[]\>

Retrieves all agents from the database.

#### Returns

`Promise`\<`Agent`[]\>

A Promise that resolves to an array of Agent objects.

#### Implementation of

[`IDatabaseAdapter`](../interfaces/IDatabaseAdapter.md).[`getAgents`](../interfaces/IDatabaseAdapter.md#getAgents)

#### Defined in

[packages/core/src/database.ts:440](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L440)

---

### createAgent()

> `abstract` **createAgent**(`agent`): `Promise`\<`boolean`\>

Creates a new agent in the database.

#### Parameters

• **agent**: `Partial`\<`Agent`\>

The agent object to create.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure of the creation.

#### Implementation of

`IDatabaseAdapter.createAgent`

#### Defined in

[packages/core/src/database.ts:447](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L447)

---

### updateAgent()

> `abstract` **updateAgent**(`agentId`, `agent`): `Promise`\<`boolean`\>

Updates an existing agent in the database.

#### Parameters

• **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the agent to update.

• **agent**: `Partial`\<`Agent`\>

The agent object with updated properties.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure of the update.

#### Implementation of

`IDatabaseAdapter.updateAgent`

#### Defined in

[packages/core/src/database.ts:455](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L455)

---

### deleteAgent()

> `abstract` **deleteAgent**(`agentId`): `Promise`\<`boolean`\>

Deletes an agent from the database.

#### Parameters

• **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the agent to delete.

#### Returns

`Promise`\<`boolean`\>

A Promise that resolves to a boolean indicating success or failure of the deletion.

#### Implementation of

`IDatabaseAdapter.deleteAgent`

#### Defined in

[packages/core/src/database.ts:462](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L462)

---

### ensureAgentExists()

> `abstract` **ensureAgentExists**(`agent`): `Promise`\<`Agent`\>

Ensures an agent exists in the database.

#### Parameters

• **agent**: `Partial`\<`Agent`\>

The agent object to ensure exists.

#### Returns

`Promise`\<`Agent`\>

A Promise that resolves when the agent has been ensured to exist.

#### Implementation of

`IDatabaseAdapter.ensureAgentExists`

#### Defined in

[packages/core/src/database.ts:469](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L469)

---

### ensureEmbeddingDimension()

> `abstract` **ensureEmbeddingDimension**(`dimension`): `Promise`\<`void`\>

Ensures an embedding dimension exists in the database.

#### Parameters

• **dimension**: `number`

The dimension to ensure exists.

#### Returns

`Promise`\<`void`\>

A Promise that resolves when the embedding dimension has been ensured to exist.

#### Implementation of

`IDatabaseAdapter.ensureEmbeddingDimension`

#### Defined in

[packages/core/src/database.ts:476](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L476)

---

### getCache()

> `abstract` **getCache**\<`T`\>(`key`): `Promise`\<`T`\>

Retrieves a cached value by key from the database.

#### Type Parameters

• **T**

#### Parameters

• **key**: `string`

The key to look up in the cache

#### Returns

`Promise`\<`T`\>

Promise resolving to the cached string value

#### Implementation of

`IDatabaseAdapter.getCache`

#### Defined in

[packages/core/src/database.ts:483](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L483)

---

### setCache()

> `abstract` **setCache**\<`T`\>(`key`, `value`): `Promise`\<`boolean`\>

Sets a value in the cache with the given key.

#### Type Parameters

• **T**

#### Parameters

• **key**: `string`

The key to store the value under

• **value**: `T`

The string value to cache

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if the cache was set successfully

#### Implementation of

`IDatabaseAdapter.setCache`

#### Defined in

[packages/core/src/database.ts:492](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L492)

---

### deleteCache()

> `abstract` **deleteCache**(`key`): `Promise`\<`boolean`\>

Deletes a value from the cache by key.

#### Parameters

• **key**: `string`

The key to delete from the cache

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if the value was successfully deleted

#### Implementation of

`IDatabaseAdapter.deleteCache`

#### Defined in

[packages/core/src/database.ts:499](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L499)

---

### createTask()

> `abstract` **createTask**(`task`): `Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

Creates a new task instance in the database.

#### Parameters

• **task**: `Task`

The task object to create

#### Returns

`Promise`\<\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`\>

Promise resolving to the UUID of the created task

#### Implementation of

`IDatabaseAdapter.createTask`

#### Defined in

[packages/core/src/database.ts:506](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L506)

---

### getTasks()

> `abstract` **getTasks**(`params`): `Promise`\<`Task`[]\>

Retrieves tasks based on specified parameters.

#### Parameters

• **params**

Object containing optional roomId and tags to filter tasks

• **params.roomId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

#### Returns

`Promise`\<`Task`[]\>

Promise resolving to an array of Task objects

#### Implementation of

`IDatabaseAdapter.getTasks`

#### Defined in

[packages/core/src/database.ts:513](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L513)

---

### getTask()

> `abstract` **getTask**(`id`): `Promise`\<`Task`\>

Retrieves a specific task by its ID.

#### Parameters

• **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the task to retrieve

#### Returns

`Promise`\<`Task`\>

Promise resolving to the Task object if found, null otherwise

#### Implementation of

`IDatabaseAdapter.getTask`

#### Defined in

[packages/core/src/database.ts:520](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L520)

---

### getTasksByName()

> `abstract` **getTasksByName**(`name`): `Promise`\<`Task`[]\>

Retrieves a specific task by its name.

#### Parameters

• **name**: `string`

The name of the task to retrieve

#### Returns

`Promise`\<`Task`[]\>

Promise resolving to the Task object if found, null otherwise

#### Implementation of

`IDatabaseAdapter.getTasksByName`

#### Defined in

[packages/core/src/database.ts:527](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L527)

---

### updateTask()

> `abstract` **updateTask**(`id`, `task`): `Promise`\<`void`\>

Updates an existing task in the database.

#### Parameters

• **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the task to update

• **task**: `Partial`\<`Task`\>

Partial Task object containing the fields to update

#### Returns

`Promise`\<`void`\>

Promise resolving when the update is complete

#### Implementation of

`IDatabaseAdapter.updateTask`

#### Defined in

[packages/core/src/database.ts:535](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L535)

---

### deleteTask()

> `abstract` **deleteTask**(`id`): `Promise`\<`void`\>

Deletes a task from the database.

#### Parameters

• **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID of the task to delete

#### Returns

`Promise`\<`void`\>

Promise resolving when the deletion is complete

#### Implementation of

`IDatabaseAdapter.deleteTask`

#### Defined in

[packages/core/src/database.ts:542](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database.ts#L542)
```

## File: packages/docs/api/classes/Service.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Service

# Class: `abstract` Service

Client instance

## Extended by

- [`TypedService`](../interfaces/TypedService.md)

## Properties

### runtime

> `protected` **runtime**: `IAgentRuntime`

Runtime instance

#### Defined in

[packages/core/src/types.ts:519](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L519)

---

### serviceType

> `static` **serviceType**: `string`

Service type

#### Defined in

[packages/core/src/types.ts:530](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L530)

---

### capabilityDescription

> `abstract` **capabilityDescription**: `string`

Service name

#### Defined in

[packages/core/src/types.ts:533](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L533)

---

### config?

> `optional` **config**: `object`

Service configuration

#### Index Signature

\[`key`: `string`\]: `any`

#### Defined in

[packages/core/src/types.ts:536](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L536)

## Methods

### start()

> `static` **start**(`_runtime`): `Promise`\<[`Service`](Service.md)\>

Start service connection

#### Parameters

• **\_runtime**: `IAgentRuntime`

#### Returns

`Promise`\<[`Service`](Service.md)\>

#### Defined in

[packages/core/src/types.ts:539](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L539)

---

### stop()

> `static` **stop**(`_runtime`): `Promise`\<`unknown`\>

Stop service connection

#### Parameters

• **\_runtime**: `IAgentRuntime`

#### Returns

`Promise`\<`unknown`\>

#### Defined in

[packages/core/src/types.ts:544](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L544)
```

## File: packages/docs/api/enumerations/EventType.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EventType

# Enumeration: EventType

Standard event types across all platforms

## Enumeration Members

### WORLD_JOINED

> **WORLD_JOINED**: `"WORLD_JOINED"`

#### Defined in

[packages/core/src/types.ts:1507](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1507)

---

### WORLD_CONNECTED

> **WORLD_CONNECTED**: `"WORLD_CONNECTED"`

#### Defined in

[packages/core/src/types.ts:1508](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1508)

---

### WORLD_LEFT

> **WORLD_LEFT**: `"WORLD_LEFT"`

#### Defined in

[packages/core/src/types.ts:1509](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1509)

---

### ENTITY_JOINED

> **ENTITY_JOINED**: `"ENTITY_JOINED"`

#### Defined in

[packages/core/src/types.ts:1512](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1512)

---

### ENTITY_LEFT

> **ENTITY_LEFT**: `"ENTITY_LEFT"`

#### Defined in

[packages/core/src/types.ts:1513](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1513)

---

### ENTITY_UPDATED

> **ENTITY_UPDATED**: `"ENTITY_UPDATED"`

#### Defined in

[packages/core/src/types.ts:1514](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1514)

---

### ROOM_JOINED

> **ROOM_JOINED**: `"ROOM_JOINED"`

#### Defined in

[packages/core/src/types.ts:1517](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1517)

---

### ROOM_LEFT

> **ROOM_LEFT**: `"ROOM_LEFT"`

#### Defined in

[packages/core/src/types.ts:1518](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1518)

---

### MESSAGE_RECEIVED

> **MESSAGE_RECEIVED**: `"MESSAGE_RECEIVED"`

#### Defined in

[packages/core/src/types.ts:1521](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1521)

---

### MESSAGE_SENT

> **MESSAGE_SENT**: `"MESSAGE_SENT"`

#### Defined in

[packages/core/src/types.ts:1522](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1522)

---

### VOICE_MESSAGE_RECEIVED

> **VOICE_MESSAGE_RECEIVED**: `"VOICE_MESSAGE_RECEIVED"`

#### Defined in

[packages/core/src/types.ts:1525](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1525)

---

### VOICE_MESSAGE_SENT

> **VOICE_MESSAGE_SENT**: `"VOICE_MESSAGE_SENT"`

#### Defined in

[packages/core/src/types.ts:1526](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1526)

---

### REACTION_RECEIVED

> **REACTION_RECEIVED**: `"REACTION_RECEIVED"`

#### Defined in

[packages/core/src/types.ts:1529](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1529)

---

### POST_GENERATED

> **POST_GENERATED**: `"POST_GENERATED"`

#### Defined in

[packages/core/src/types.ts:1530](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1530)

---

### INTERACTION_RECEIVED

> **INTERACTION_RECEIVED**: `"INTERACTION_RECEIVED"`

#### Defined in

[packages/core/src/types.ts:1531](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1531)

---

### RUN_STARTED

> **RUN_STARTED**: `"RUN_STARTED"`

#### Defined in

[packages/core/src/types.ts:1534](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1534)

---

### RUN_ENDED

> **RUN_ENDED**: `"RUN_ENDED"`

#### Defined in

[packages/core/src/types.ts:1535](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1535)

---

### RUN_TIMEOUT

> **RUN_TIMEOUT**: `"RUN_TIMEOUT"`

#### Defined in

[packages/core/src/types.ts:1536](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1536)

---

### ACTION_STARTED

> **ACTION_STARTED**: `"ACTION_STARTED"`

#### Defined in

[packages/core/src/types.ts:1539](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1539)

---

### ACTION_COMPLETED

> **ACTION_COMPLETED**: `"ACTION_COMPLETED"`

#### Defined in

[packages/core/src/types.ts:1540](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1540)

---

### EVALUATOR_STARTED

> **EVALUATOR_STARTED**: `"EVALUATOR_STARTED"`

#### Defined in

[packages/core/src/types.ts:1543](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1543)

---

### EVALUATOR_COMPLETED

> **EVALUATOR_COMPLETED**: `"EVALUATOR_COMPLETED"`

#### Defined in

[packages/core/src/types.ts:1544](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1544)

---

### MODEL_USED

> **MODEL_USED**: `"MODEL_USED"`

#### Defined in

[packages/core/src/types.ts:1547](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1547)
```

## File: packages/docs/api/enumerations/PlatformPrefix.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / PlatformPrefix

# Enumeration: PlatformPrefix

Platform-specific event type prefix

## Enumeration Members

### DISCORD

> **DISCORD**: `"DISCORD"`

#### Defined in

[packages/core/src/types.ts:1554](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1554)

---

### TELEGRAM

> **TELEGRAM**: `"TELEGRAM"`

#### Defined in

[packages/core/src/types.ts:1555](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1555)

---

### TWITTER

> **TWITTER**: `"TWITTER"`

#### Defined in

[packages/core/src/types.ts:1556](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1556)
```

## File: packages/docs/api/enumerations/SOCKET_MESSAGE_TYPE.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / SOCKET_MESSAGE_TYPE

# Enumeration: SOCKET_MESSAGE_TYPE

Update the Plugin interface with typed events

## Enumeration Members

### ROOM_JOINING

> **ROOM_JOINING**: `1`

#### Defined in

[packages/core/src/types.ts:1714](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1714)

---

### SEND_MESSAGE

> **SEND_MESSAGE**: `2`

#### Defined in

[packages/core/src/types.ts:1715](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1715)

---

### MESSAGE

> **MESSAGE**: `3`

#### Defined in

[packages/core/src/types.ts:1716](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1716)

---

### ACK

> **ACK**: `4`

#### Defined in

[packages/core/src/types.ts:1717](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1717)

---

### THINKING

> **THINKING**: `5`

#### Defined in

[packages/core/src/types.ts:1718](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1718)

---

### CONTROL

> **CONTROL**: `6`

#### Defined in

[packages/core/src/types.ts:1719](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1719)
```

## File: packages/docs/api/functions/addHeader.md

````markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / addHeader

# Function: addHeader()

> **addHeader**(`header`, `body`): `string`

Adds a header to a body of text.

This function takes a header string and a body string and returns a new string with the header prepended to the body.
If the body string is empty, the header is returned as is.

## Parameters

• **header**: `string`

The header to add to the body.

• **body**: `string`

The body to which to add the header.

## Returns

`string`

The body with the header prepended.

## Example

```ts
// Given a header and a body
const header = 'Header';
const body = 'Body';

// Adding the header to the body will result in:
// "Header\nBody"
const text = addHeader(header, body);
```

## Defined in

[packages/core/src/prompts.ts:107](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L107)
````

## File: packages/docs/api/functions/asUUID.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / asUUID

# Function: asUUID()

> **asUUID**(`id`): \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Helper function to safely cast a string to strongly typed UUID

## Parameters

• **id**: `string`

The string UUID to validate and cast

## Returns

\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The same UUID with branded type information

## Defined in

[packages/core/src/types.ts:15](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L15)
```

## File: packages/docs/api/functions/cleanJsonResponse.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / cleanJsonResponse

# Function: cleanJsonResponse()

> **cleanJsonResponse**(`response`): `string`

Cleans a JSON-like response string by removing unnecessary markers, line breaks, and extra whitespace.
This is useful for handling improperly formatted JSON responses from external sources.

## Parameters

• **response**: `string`

The raw JSON-like string response to clean.

## Returns

`string`

The cleaned string, ready for parsing or further processing.

## Defined in

[packages/core/src/prompts.ts:576](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L576)
```

## File: packages/docs/api/functions/composeActionExamples.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / composeActionExamples

# Function: composeActionExamples()

> **composeActionExamples**(`actionsData`, `count`): `string`

Compose a specified number of random action examples from the given actionsData.

## Parameters

• **actionsData**: [`Action`](../interfaces/Action.md)[]

The list of actions to generate examples from.

• **count**: `number`

The number of examples to compose.

## Returns

`string`

The formatted action examples.

## Defined in

[packages/core/src/actions.ts:18](https://github.com/elizaOS/eliza/blob/main/packages/core/src/actions.ts#L18)
```

## File: packages/docs/api/functions/composePrompt.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / composePrompt

# Function: composePrompt()

> **composePrompt**(`options`): `string`

Function to compose a prompt using a provided template and state.

## Parameters

• **options**

Object containing state and template information.

• **options.state**

The state object containing values to fill the template.

• **options.template**: `TemplateType`

The template to be used for composing the prompt.

## Returns

`string`

The composed prompt output.

## Defined in

[packages/core/src/prompts.ts:45](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L45)
```

## File: packages/docs/api/functions/composePromptFromState.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / composePromptFromState

# Function: composePromptFromState()

> **composePromptFromState**(`options`): `string`

Function to compose a prompt using a provided template and state.

## Parameters

• **options**

Object containing state and template information.

• **options.state**: [`State`](../interfaces/State.md)

The state object containing values to fill the template.

• **options.template**: `TemplateType`

The template to be used for composing the prompt.

## Returns

`string`

The composed prompt output.

## Defined in

[packages/core/src/prompts.ts:66](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L66)
```

## File: packages/docs/api/functions/composeRandomUser.md

````markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / composeRandomUser

# Function: composeRandomUser()

> **composeRandomUser**(`template`, `length`): `string`

Generates a string with random user names populated in a template.

This function generates random user names and populates placeholders
in the provided template with these names. Placeholders in the template should follow the format `{{userX}}`
where `X` is the position of the user (e.g., `{{name1}}`, `{{name2}}`).

## Parameters

• **template**: `string`

The template string containing placeholders for random user names.

• **length**: `number`

The number of random user names to generate.

## Returns

`string`

The template string with placeholders replaced by random user names.

## Example

```ts
// Given a template and a length
const template = 'Hello, {{name1}}! Meet {{name2}} and {{name3}}.';
const length = 3;

// Composing the random user string will result in:
// "Hello, John! Meet Alice and Bob."
const result = composeRandomUser(template, length);
```

## Defined in

[packages/core/src/prompts.ts:131](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L131)
````

## File: packages/docs/api/functions/createMessageMemory.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / createMessageMemory

# Function: createMessageMemory()

> **createMessageMemory**(`params`): [`MessageMemory`](../interfaces/MessageMemory.md)

Factory function to create a new message memory with proper defaults

## Parameters

• **params**

• **params.id?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.agentId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.content**: [`Content`](../interfaces/Content.md) & `object`

• **params.embedding?**: `number`[]

## Returns

[`MessageMemory`](../interfaces/MessageMemory.md)

## Defined in

[packages/core/src/types.ts:1735](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1735)
```

## File: packages/docs/api/functions/createServiceError.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / createServiceError

# Function: createServiceError()

> **createServiceError**(`error`, `code`): [`ServiceError`](../interfaces/ServiceError.md)

Safely create a ServiceError from any caught error

## Parameters

• **error**: `unknown`

• **code**: `string` = `'UNKNOWN_ERROR'`

## Returns

[`ServiceError`](../interfaces/ServiceError.md)

## Defined in

[packages/core/src/types.ts:1905](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1905)
```

## File: packages/docs/api/functions/createSettingFromConfig.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / createSettingFromConfig

# Function: createSettingFromConfig()

> **createSettingFromConfig**(`configSetting`): `Setting`

Creates a Setting object from a configSetting object by omitting the 'value' property.

## Parameters

• **configSetting**: `Omit`\<`Setting`, `"value"`\>

The configSetting object to create the Setting from.

## Returns

`Setting`

A new Setting object created from the provided configSetting object.

## Defined in

[packages/core/src/settings.ts:24](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L24)
```

## File: packages/docs/api/functions/createUniqueUuid.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / createUniqueUuid

# Function: createUniqueUuid()

> **createUniqueUuid**(`runtime`, `baseUserId`): \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Function to create a unique UUID based on the runtime and base user ID.

## Parameters

• **runtime**: `any`

The runtime context object.

• **baseUserId**: `string`

The base user ID to use in generating the UUID.

## Returns

\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

- The unique UUID generated based on the runtime and base user ID.

## Defined in

[packages/core/src/entities.ts:300](https://github.com/elizaOS/eliza/blob/main/packages/core/src/entities.ts#L300)
```

## File: packages/docs/api/functions/decryptedCharacter.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / decryptedCharacter

# Function: decryptedCharacter()

> **decryptedCharacter**(`character`, `runtime`): [`Character`](../interfaces/Character.md)

Decrypts sensitive data in a Character object

## Parameters

• **character**: [`Character`](../interfaces/Character.md)

The character object with encrypted secrets

• **runtime**: `IAgentRuntime`

The runtime information needed for salt generation

## Returns

[`Character`](../interfaces/Character.md)

- A copy of the character with decrypted secrets

## Defined in

[packages/core/src/settings.ts:365](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L365)
```

## File: packages/docs/api/functions/decryptObjectValues.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / decryptObjectValues

# Function: decryptObjectValues()

> **decryptObjectValues**(`obj`, `salt`): `Record`\<`string`, `any`\>

Helper function to decrypt all string values in an object

## Parameters

• **obj**: `Record`\<`string`, `any`\>

Object with encrypted values

• **salt**: `string`

The salt to use for decryption

## Returns

`Record`\<`string`, `any`\>

- Object with decrypted values

## Defined in

[packages/core/src/settings.ts:409](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L409)
```

## File: packages/docs/api/functions/decryptStringValue.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / decryptStringValue

# Function: decryptStringValue()

> **decryptStringValue**(`value`, `salt`): `string`

Common decryption function for string values

## Parameters

• **value**: `string`

The encrypted value in 'iv:encrypted' format

• **salt**: `string`

The salt to use for decryption

## Returns

`string`

- The decrypted string value

## Defined in

[packages/core/src/settings.ts:120](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L120)
```

## File: packages/docs/api/functions/encryptedCharacter.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / encryptedCharacter

# Function: encryptedCharacter()

> **encryptedCharacter**(`character`): [`Character`](../interfaces/Character.md)

Encrypts sensitive data in a Character object

## Parameters

• **character**: [`Character`](../interfaces/Character.md)

The character object to encrypt secrets for

## Returns

[`Character`](../interfaces/Character.md)

- A copy of the character with encrypted secrets

## Defined in

[packages/core/src/settings.ts:341](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L341)
```

## File: packages/docs/api/functions/encryptObjectValues.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / encryptObjectValues

# Function: encryptObjectValues()

> **encryptObjectValues**(`obj`, `salt`): `Record`\<`string`, `any`\>

Helper function to encrypt all string values in an object

## Parameters

• **obj**: `Record`\<`string`, `any`\>

Object with values to encrypt

• **salt**: `string`

The salt to use for encryption

## Returns

`Record`\<`string`, `any`\>

- Object with encrypted values

## Defined in

[packages/core/src/settings.ts:389](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L389)
```

## File: packages/docs/api/functions/encryptStringValue.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / encryptStringValue

# Function: encryptStringValue()

> **encryptStringValue**(`value`, `salt`): `string`

Common encryption function for string values

## Parameters

• **value**: `string`

The string value to encrypt

• **salt**: `string`

The salt to use for encryption

## Returns

`string`

- The encrypted value in 'iv:encrypted' format

## Defined in

[packages/core/src/settings.ts:67](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L67)
```

## File: packages/docs/api/functions/extractAttributes.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / extractAttributes

# Function: extractAttributes()

> **extractAttributes**(`response`, `attributesToExtract`?): `object`

Extracts specific attributes (e.g., user, text, action) from a JSON-like string using regex.

## Parameters

• **response**: `string`

The cleaned string response to extract attributes from.

• **attributesToExtract?**: `string`[]

An array of attribute names to extract.

## Returns

`object`

An object containing the extracted attributes.

## Defined in

[packages/core/src/prompts.ts:510](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L510)
```

## File: packages/docs/api/functions/findEntityByName.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / findEntityByName

# Function: findEntityByName()

> **findEntityByName**(`runtime`, `message`, `state`): `Promise`\<[`Entity`](../interfaces/Entity.md)\>

Finds an entity by name in the given runtime environment.

## Parameters

• **runtime**: `IAgentRuntime`

The agent runtime environment.

• **message**: [`Memory`](../interfaces/Memory.md)

The memory message containing relevant information.

• **state**: [`State`](../interfaces/State.md)

The current state of the system.

## Returns

`Promise`\<[`Entity`](../interfaces/Entity.md)\>

A promise that resolves to the found entity or null if not found.

## Defined in

[packages/core/src/entities.ts:134](https://github.com/elizaOS/eliza/blob/main/packages/core/src/entities.ts#L134)
```

## File: packages/docs/api/functions/findWorldsForOwner.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / findWorldsForOwner

# Function: findWorldsForOwner()

> **findWorldsForOwner**(`runtime`, `entityId`): `Promise`\<`World`[]\>

Finds a server where the given user is the owner

## Parameters

• **runtime**: `IAgentRuntime`

• **entityId**: `string`

## Returns

`Promise`\<`World`[]\>

## Defined in

[packages/core/src/roles.ts:64](https://github.com/elizaOS/eliza/blob/main/packages/core/src/roles.ts#L64)
```

## File: packages/docs/api/functions/formatActionNames.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / formatActionNames

# Function: formatActionNames()

> **formatActionNames**(`actions`): `string`

Formats the names of the provided actions into a comma-separated string.

## Parameters

• **actions**: [`Action`](../interfaces/Action.md)[]

An array of `Action` objects from which to extract names.

## Returns

`string`

A comma-separated string of action names.

## Defined in

[packages/core/src/actions.ts:63](https://github.com/elizaOS/eliza/blob/main/packages/core/src/actions.ts#L63)
```

## File: packages/docs/api/functions/formatActions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / formatActions

# Function: formatActions()

> **formatActions**(`actions`): `string`

Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.

## Parameters

• **actions**: [`Action`](../interfaces/Action.md)[]

An array of `Action` objects to format.

## Returns

`string`

A detailed string of actions, including names and descriptions.

## Defined in

[packages/core/src/actions.ts:75](https://github.com/elizaOS/eliza/blob/main/packages/core/src/actions.ts#L75)
```

## File: packages/docs/api/functions/formatEntities.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / formatEntities

# Function: formatEntities()

> **formatEntities**(`options`): `string`

Format the given entities into a string representation.

## Parameters

• **options**

The options object.

• **options.entities**: [`Entity`](../interfaces/Entity.md)[]

The list of entities to format.

## Returns

`string`

A formatted string representing the entities.

## Defined in

[packages/core/src/entities.ts:391](https://github.com/elizaOS/eliza/blob/main/packages/core/src/entities.ts#L391)
```

## File: packages/docs/api/functions/formatMessages.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / formatMessages

# Function: formatMessages()

> **formatMessages**(`params`): `string`

Format messages into a string

## Parameters

• **params**

The formatting parameters

• **params.messages**: [`Memory`](../interfaces/Memory.md)[]

List of messages to format

• **params.entities**: [`Entity`](../interfaces/Entity.md)[]

List of entities for name resolution

## Returns

`string`

Formatted message string with timestamps and user information

## Defined in

[packages/core/src/prompts.ts:204](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L204)
```

## File: packages/docs/api/functions/getBrowserService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getBrowserService

# Function: getBrowserService()

> **getBrowserService**(`runtime`): `IBrowserService`

Type-safe helper for accessing the browser service

## Parameters

• **runtime**: `IAgentRuntime`

## Returns

`IBrowserService`

## Defined in

[packages/core/src/types.ts:1856](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1856)
```

## File: packages/docs/api/functions/getEntityDetails.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getEntityDetails

# Function: getEntityDetails()

> **getEntityDetails**(`params`): `Promise`\<`any`[]\>

Retrieves entity details for a specific room from the database.

## Parameters

• **params**

The input parameters

• **params.runtime**: `IAgentRuntime`

The Agent Runtime instance

• **params.roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The ID of the room to retrieve entity details for

## Returns

`Promise`\<`any`[]\>

- A promise that resolves to an array of unique entity details

## Defined in

[packages/core/src/entities.ts:325](https://github.com/elizaOS/eliza/blob/main/packages/core/src/entities.ts#L325)
```

## File: packages/docs/api/functions/getFileService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getFileService

# Function: getFileService()

> **getFileService**(`runtime`): `IFileService`

Type-safe helper for accessing the file service

## Parameters

• **runtime**: `IAgentRuntime`

## Returns

`IFileService`

## Defined in

[packages/core/src/types.ts:1870](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1870)
```

## File: packages/docs/api/functions/getMemoryText.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getMemoryText

# Function: getMemoryText()

> **getMemoryText**(`memory`, `defaultValue`): `string`

Safely access the text content of a memory

## Parameters

• **memory**: [`Memory`](../interfaces/Memory.md)

The memory to extract text from

• **defaultValue**: `string` = `''`

Optional default value if no text is found

## Returns

`string`

The text content or default value

## Defined in

[packages/core/src/types.ts:1898](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1898)
```

## File: packages/docs/api/functions/getPdfService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getPdfService

# Function: getPdfService()

> **getPdfService**(`runtime`): `IPdfService`

Type-safe helper for accessing the PDF service

## Parameters

• **runtime**: `IAgentRuntime`

## Returns

`IPdfService`

## Defined in

[packages/core/src/types.ts:1863](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1863)
```

## File: packages/docs/api/functions/getSalt.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getSalt

# Function: getSalt()

> **getSalt**(): `string`

Retrieves the salt based on env variable SECRET_SALT

## Returns

`string`

The salt for the agent.

## Defined in

[packages/core/src/settings.ts:45](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L45)
```

## File: packages/docs/api/functions/getTypedService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getTypedService

# Function: getTypedService()

> **getTypedService**\<`T`\>(`runtime`, `serviceType`): `T`

Generic factory function to create a typed service instance

## Type Parameters

• **T** _extends_ [`TypedService`](../interfaces/TypedService.md)\<`any`, `any`\>

## Parameters

• **runtime**: `IAgentRuntime`

The agent runtime

• **serviceType**: `ServiceTypeName`

The type of service to get

## Returns

`T`

The service instance or null if not available

## Defined in

[packages/core/src/types.ts:1779](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1779)
```

## File: packages/docs/api/functions/getUserServerRole.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getUserServerRole

# Function: getUserServerRole()

> **getUserServerRole**(`runtime`, `entityId`, `serverId`): `Promise`\<`Role`\>

Retrieve the server role of a specified user entity within a given server.

## Parameters

• **runtime**: `IAgentRuntime`

The runtime object containing necessary configurations and services.

• **entityId**: `string`

The unique identifier of the user entity.

• **serverId**: `string`

The unique identifier of the server.

## Returns

`Promise`\<`Role`\>

The role of the user entity within the server, resolved as a Promise.

## Defined in

[packages/core/src/roles.ts:32](https://github.com/elizaOS/eliza/blob/main/packages/core/src/roles.ts#L32)
```

## File: packages/docs/api/functions/getVideoService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getVideoService

# Function: getVideoService()

> **getVideoService**(`runtime`): `IVideoService`

Type-safe helper for accessing the video service

## Parameters

• **runtime**: `IAgentRuntime`

## Returns

`IVideoService`

## Defined in

[packages/core/src/types.ts:1849](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1849)
```

## File: packages/docs/api/functions/getWavHeader.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getWavHeader

# Function: getWavHeader()

> **getWavHeader**(`audioLength`, `sampleRate`, `channelCount`?, `bitsPerSample`?): `Buffer`

Generates a WAV file header based on the provided audio parameters.

## Parameters

• **audioLength**: `number`

The length of the audio data in bytes.

• **sampleRate**: `number`

The sample rate of the audio.

• **channelCount?**: `number` = `1`

The number of channels (default is 1).

• **bitsPerSample?**: `number` = `16`

The number of bits per sample (default is 16).

## Returns

`Buffer`

The WAV file header as a Buffer object.

## Defined in

[packages/core/src/audioUtils.ts:13](https://github.com/elizaOS/eliza/blob/main/packages/core/src/audioUtils.ts#L13)
```

## File: packages/docs/api/functions/getWorldSettings.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / getWorldSettings

# Function: getWorldSettings()

> **getWorldSettings**(`runtime`, `serverId`): `Promise`\<`WorldSettings`\>

Gets settings state from world metadata

## Parameters

• **runtime**: `IAgentRuntime`

• **serverId**: `string`

## Returns

`Promise`\<`WorldSettings`\>

## Defined in

[packages/core/src/settings.ts:265](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L265)
```

## File: packages/docs/api/functions/initializeOnboarding.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / initializeOnboarding

# Function: initializeOnboarding()

> **initializeOnboarding**(`runtime`, `world`, `config`): `Promise`\<`WorldSettings`\>

Initializes settings configuration for a server

## Parameters

• **runtime**: `IAgentRuntime`

• **world**: `World`

• **config**: `OnboardingConfig`

## Returns

`Promise`\<`WorldSettings`\>

## Defined in

[packages/core/src/settings.ts:292](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L292)
```

## File: packages/docs/api/functions/isCustomMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isCustomMetadata

# Function: isCustomMetadata()

> **isCustomMetadata**(`metadata`): `metadata is CustomMetadata`

Type guard to check if a memory metadata is a CustomMetadata

## Parameters

• **metadata**: `MemoryMetadata`

The metadata to check

## Returns

`metadata is CustomMetadata`

True if the metadata is a CustomMetadata

## Defined in

[packages/core/src/types.ts:1827](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1827)
```

## File: packages/docs/api/functions/isDescriptionMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isDescriptionMetadata

# Function: isDescriptionMetadata()

> **isDescriptionMetadata**(`metadata`): `metadata is DescriptionMetadata`

Type guard to check if a memory metadata is a DescriptionMetadata

## Parameters

• **metadata**: `MemoryMetadata`

The metadata to check

## Returns

`metadata is DescriptionMetadata`

True if the metadata is a DescriptionMetadata

## Defined in

[packages/core/src/types.ts:1818](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1818)
```

## File: packages/docs/api/functions/isDocumentMemory.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isDocumentMemory

# Function: isDocumentMemory()

> **isDocumentMemory**(`memory`): `memory is Memory & { metadata: DocumentMetadata }`

Memory type guard for document memories

## Parameters

• **memory**: [`Memory`](../interfaces/Memory.md)

## Returns

`memory is Memory & { metadata: DocumentMetadata }`

## Defined in

[packages/core/src/types.ts:1877](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1877)
```

## File: packages/docs/api/functions/isDocumentMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isDocumentMetadata

# Function: isDocumentMetadata()

> **isDocumentMetadata**(`metadata`): `metadata is DocumentMetadata`

Type guard to check if a memory metadata is a DocumentMetadata

## Parameters

• **metadata**: `MemoryMetadata`

The metadata to check

## Returns

`metadata is DocumentMetadata`

True if the metadata is a DocumentMetadata

## Defined in

[packages/core/src/types.ts:1791](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1791)
```

## File: packages/docs/api/functions/isFragmentMemory.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isFragmentMemory

# Function: isFragmentMemory()

> **isFragmentMemory**(`memory`): `memory is Memory & { metadata: FragmentMetadata }`

Memory type guard for fragment memories

## Parameters

• **memory**: [`Memory`](../interfaces/Memory.md)

## Returns

`memory is Memory & { metadata: FragmentMetadata }`

## Defined in

[packages/core/src/types.ts:1886](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1886)
```

## File: packages/docs/api/functions/isFragmentMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isFragmentMetadata

# Function: isFragmentMetadata()

> **isFragmentMetadata**(`metadata`): `metadata is FragmentMetadata`

Type guard to check if a memory metadata is a FragmentMetadata

## Parameters

• **metadata**: `MemoryMetadata`

The metadata to check

## Returns

`metadata is FragmentMetadata`

True if the metadata is a FragmentMetadata

## Defined in

[packages/core/src/types.ts:1800](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1800)
```

## File: packages/docs/api/functions/isMessageMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / isMessageMetadata

# Function: isMessageMetadata()

> **isMessageMetadata**(`metadata`): `metadata is MessageMetadata`

Type guard to check if a memory metadata is a MessageMetadata

## Parameters

• **metadata**: `MemoryMetadata`

The metadata to check

## Returns

`metadata is MessageMetadata`

True if the metadata is a MessageMetadata

## Defined in

[packages/core/src/types.ts:1809](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1809)
```

## File: packages/docs/api/functions/normalizeJsonString.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / normalizeJsonString

# Function: normalizeJsonString()

> **normalizeJsonString**(`str`): `string`

Normalizes a JSON-like string by correcting formatting issues:

- Removes extra spaces after '{' and before '}'.
- Wraps unquoted values in double quotes.
- Converts single-quoted values to double-quoted.
- Ensures consistency in key-value formatting.
- Normalizes mixed adjacent quote pairs.

This is useful for cleaning up improperly formatted JSON strings
before parsing them into valid JSON.

## Parameters

• **str**: `string`

The JSON-like string to normalize.

## Returns

`string`

A properly formatted JSON string.

## Defined in

[packages/core/src/prompts.ts:550](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L550)
```

## File: packages/docs/api/functions/parseBooleanFromText.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / parseBooleanFromText

# Function: parseBooleanFromText()

> **parseBooleanFromText**(`value`): `boolean`

Parses a string to determine its boolean equivalent.

Recognized affirmative values: "YES", "Y", "TRUE", "T", "1", "ON", "ENABLE"
Recognized negative values: "NO", "N", "FALSE", "F", "0", "OFF", "DISABLE"

## Parameters

• **value**: `string`

The input text to parse

## Returns

`boolean`

- Returns `true` for affirmative inputs, `false` for negative or unrecognized inputs

## Defined in

[packages/core/src/prompts.ts:390](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L390)
```

## File: packages/docs/api/functions/parseJsonArrayFromText.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / parseJsonArrayFromText

# Function: parseJsonArrayFromText()

> **parseJsonArrayFromText**(`text`): `any`[]

Parses a JSON array from a given text. The function looks for a JSON block wrapped in triple backticks
with `json` language identifier, and if not found, it searches for an array pattern within the text.
It then attempts to parse the JSON string into a JavaScript object. If parsing is successful and the result
is an array, it returns the array; otherwise, it returns null.

## Parameters

• **text**: `string`

The input text from which to extract and parse the JSON array.

## Returns

`any`[]

An array parsed from the JSON string if successful; otherwise, null.

## Defined in

[packages/core/src/prompts.ts:428](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L428)
```

## File: packages/docs/api/functions/parseJSONObjectFromText.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / parseJSONObjectFromText

# Function: parseJSONObjectFromText()

> **parseJSONObjectFromText**(`text`): `Record`\<`string`, `any`\>

Parses a JSON object from a given text. The function looks for a JSON block wrapped in triple backticks
with `json` language identifier, and if not found, it searches for an object pattern within the text.
It then attempts to parse the JSON string into a JavaScript object. If parsing is successful and the result
is an object (but not an array), it returns the object; otherwise, it tries to parse an array if the result
is an array, or returns null if parsing is unsuccessful or the result is neither an object nor an array.

## Parameters

• **text**: `string`

The input text from which to extract and parse the JSON object.

## Returns

`Record`\<`string`, `any`\>

An object parsed from the JSON string if successful; otherwise, null or the result of parsing an array.

## Defined in

[packages/core/src/prompts.ts:477](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L477)
```

## File: packages/docs/api/functions/prependWavHeader.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / prependWavHeader

# Function: prependWavHeader()

> **prependWavHeader**(`readable`, `audioLength`, `sampleRate`, `channelCount`?, `bitsPerSample`?): `any`

Prepends a WAV header to a readable stream of audio data.

## Parameters

• **readable**: `any`

The readable stream containing the audio data.

• **audioLength**: `number`

The length of the audio data in seconds.

• **sampleRate**: `number`

The sample rate of the audio data.

• **channelCount?**: `number` = `1`

The number of channels in the audio data (default is 1).

• **bitsPerSample?**: `number` = `16`

The number of bits per sample in the audio data (default is 16).

## Returns

`any`

A new readable stream with the WAV header prepended to the audio data.

## Defined in

[packages/core/src/audioUtils.ts:46](https://github.com/elizaOS/eliza/blob/main/packages/core/src/audioUtils.ts#L46)
```

## File: packages/docs/api/functions/saltSettingValue.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / saltSettingValue

# Function: saltSettingValue()

> **saltSettingValue**(`setting`, `salt`): `Setting`

Applies salt to the value of a setting
Only applies to secret settings with string values

## Parameters

• **setting**: `Setting`

• **salt**: `string`

## Returns

`Setting`

## Defined in

[packages/core/src/settings.ts:171](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L171)
```

## File: packages/docs/api/functions/saltWorldSettings.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / saltWorldSettings

# Function: saltWorldSettings()

> **saltWorldSettings**(`worldSettings`, `salt`): `WorldSettings`

Applies salt to all settings in a WorldSettings object

## Parameters

• **worldSettings**: `WorldSettings`

• **salt**: `string`

## Returns

`WorldSettings`

## Defined in

[packages/core/src/settings.ts:200](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L200)
```

## File: packages/docs/api/functions/stringToUuid.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / stringToUuid

# Function: stringToUuid()

> **stringToUuid**(`target`): \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Converts a string or number to a UUID.

## Parameters

• **target**: `string` \| `number`

The string or number to convert to a UUID.

## Returns

\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The UUID generated from the input target.

## Throws

Throws an error if the input target is not a string.

## Defined in

[packages/core/src/uuid.ts:31](https://github.com/elizaOS/eliza/blob/main/packages/core/src/uuid.ts#L31)
```

## File: packages/docs/api/functions/trimTokens.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / trimTokens

# Function: trimTokens()

> **trimTokens**(`prompt`, `maxTokens`, `runtime`): `Promise`\<`string`\>

Trims the provided text prompt to a specified token limit using a tokenizer model and type.

## Parameters

• **prompt**: `string`

• **maxTokens**: `number`

• **runtime**: `IAgentRuntime`

## Returns

`Promise`\<`string`\>

## Defined in

[packages/core/src/prompts.ts:683](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L683)
```

## File: packages/docs/api/functions/truncateToCompleteSentence.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / truncateToCompleteSentence

# Function: truncateToCompleteSentence()

> **truncateToCompleteSentence**(`text`, `maxLength`): `string`

Truncate text to fit within the character limit, ensuring it ends at a complete sentence.

## Parameters

• **text**: `string`

• **maxLength**: `number`

## Returns

`string`

## Defined in

[packages/core/src/prompts.ts:630](https://github.com/elizaOS/eliza/blob/main/packages/core/src/prompts.ts#L630)
```

## File: packages/docs/api/functions/unsaltSettingValue.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / unsaltSettingValue

# Function: unsaltSettingValue()

> **unsaltSettingValue**(`setting`, `salt`): `Setting`

Removes salt from the value of a setting
Only applies to secret settings with string values

## Parameters

• **setting**: `Setting`

• **salt**: `string`

## Returns

`Setting`

## Defined in

[packages/core/src/settings.ts:186](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L186)
```

## File: packages/docs/api/functions/unsaltWorldSettings.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / unsaltWorldSettings

# Function: unsaltWorldSettings()

> **unsaltWorldSettings**(`worldSettings`, `salt`): `WorldSettings`

Removes salt from all settings in a WorldSettings object

## Parameters

• **worldSettings**: `WorldSettings`

• **salt**: `string`

## Returns

`WorldSettings`

## Defined in

[packages/core/src/settings.ts:213](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L213)
```

## File: packages/docs/api/functions/updateWorldSettings.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / updateWorldSettings

# Function: updateWorldSettings()

> **updateWorldSettings**(`runtime`, `serverId`, `worldSettings`): `Promise`\<`boolean`\>

Updates settings state in world metadata

## Parameters

• **runtime**: `IAgentRuntime`

• **serverId**: `string`

• **worldSettings**: `WorldSettings`

## Returns

`Promise`\<`boolean`\>

## Defined in

[packages/core/src/settings.ts:226](https://github.com/elizaOS/eliza/blob/main/packages/core/src/settings.ts#L226)
```

## File: packages/docs/api/functions/validateUuid.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / validateUuid

# Function: validateUuid()

> **validateUuid**(`value`): \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Validate if the given value is a valid UUID.

## Parameters

• **value**: `unknown`

The value to be validated.

## Returns

\`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

The validated UUID value or null if validation fails.

## Defined in

[packages/core/src/uuid.ts:19](https://github.com/elizaOS/eliza/blob/main/packages/core/src/uuid.ts#L19)
```

## File: packages/docs/api/interfaces/Action.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Action

# Interface: Action

Represents an action the agent can perform

## Properties

### similes?

> `optional` **similes**: `string`[]

Similar action descriptions

#### Defined in

[packages/core/src/types.ts:279](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L279)

---

### description

> **description**: `string`

Detailed description

#### Defined in

[packages/core/src/types.ts:282](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L282)

---

### examples?

> `optional` **examples**: [`ActionExample`](ActionExample.md)[][]

Example usages

#### Defined in

[packages/core/src/types.ts:285](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L285)

---

### handler

> **handler**: [`Handler`](../type-aliases/Handler.md)

Handler function

#### Defined in

[packages/core/src/types.ts:288](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L288)

---

### name

> **name**: `string`

Action name

#### Defined in

[packages/core/src/types.ts:291](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L291)

---

### validate

> **validate**: [`Validator`](../type-aliases/Validator.md)

Validation function

#### Defined in

[packages/core/src/types.ts:294](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L294)
```

## File: packages/docs/api/interfaces/ActionEventPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ActionEventPayload

# Interface: ActionEventPayload

Action event payload type

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/ActionExample.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ActionExample

# Interface: ActionExample

Example content with associated user for demonstration purposes

## Properties

### name

> **name**: `string`

User associated with the example

#### Defined in

[packages/core/src/types.ts:62](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L62)

---

### content

> **content**: [`Content`](Content.md)

Content of the example

#### Defined in

[packages/core/src/types.ts:65](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L65)
```

## File: packages/docs/api/interfaces/AudioProcessingParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / AudioProcessingParams

# Interface: AudioProcessingParams

Parameters for audio processing models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### audioUrl

> **audioUrl**: `string`

The URL or path of the audio file to process

#### Defined in

[packages/core/src/types.ts:1409](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1409)

---

### processingType

> **processingType**: `string`

The type of audio processing to perform

#### Defined in

[packages/core/src/types.ts:1411](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1411)
```

## File: packages/docs/api/interfaces/BaseMetadata.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / BaseMetadata

# Interface: BaseMetadata

Base interface for all memory metadata types
```

## File: packages/docs/api/interfaces/BaseModelParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / BaseModelParams

# Interface: BaseModelParams

Base parameters common to all model types

## Extended by

- [`TokenizeTextParams`](TokenizeTextParams.md)
- [`DetokenizeTextParams`](DetokenizeTextParams.md)
- [`TextGenerationParams`](TextGenerationParams.md)
- [`TextEmbeddingParams`](TextEmbeddingParams.md)
- [`ImageGenerationParams`](ImageGenerationParams.md)
- [`ImageDescriptionParams`](ImageDescriptionParams.md)
- [`TranscriptionParams`](TranscriptionParams.md)
- [`TextToSpeechParams`](TextToSpeechParams.md)
- [`AudioProcessingParams`](AudioProcessingParams.md)
- [`VideoProcessingParams`](VideoProcessingParams.md)
- [`ObjectGenerationParams`](ObjectGenerationParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)
```

## File: packages/docs/api/interfaces/Character.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Character

# Interface: Character

Configuration for an agent character

## Properties

### id?

> `optional` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional unique identifier

#### Defined in

[packages/core/src/types.ts:615](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L615)

---

### name

> **name**: `string`

Character name

#### Defined in

[packages/core/src/types.ts:618](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L618)

---

### username?

> `optional` **username**: `string`

Optional username

#### Defined in

[packages/core/src/types.ts:621](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L621)

---

### system?

> `optional` **system**: `string`

Optional system prompt

#### Defined in

[packages/core/src/types.ts:624](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L624)

---

### templates?

> `optional` **templates**: `object`

Optional prompt templates

#### Index Signature

\[`key`: `string`\]: `TemplateType`

#### Defined in

[packages/core/src/types.ts:627](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L627)

---

### bio

> **bio**: `string` \| `string`[]

Character biography

#### Defined in

[packages/core/src/types.ts:632](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L632)

---

### messageExamples?

> `optional` **messageExamples**: [`MessageExample`](MessageExample.md)[][]

Example messages

#### Defined in

[packages/core/src/types.ts:635](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L635)

---

### postExamples?

> `optional` **postExamples**: `string`[]

Example posts

#### Defined in

[packages/core/src/types.ts:638](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L638)

---

### topics?

> `optional` **topics**: `string`[]

Known topics

#### Defined in

[packages/core/src/types.ts:641](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L641)

---

### adjectives?

> `optional` **adjectives**: `string`[]

Character traits

#### Defined in

[packages/core/src/types.ts:644](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L644)

---

### knowledge?

> `optional` **knowledge**: (`string` \| `object` \| `object`)[]

Optional knowledge base

#### Defined in

[packages/core/src/types.ts:647](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L647)

---

### plugins?

> `optional` **plugins**: `string`[]

Available plugins

#### Defined in

[packages/core/src/types.ts:654](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L654)

---

### settings?

> `optional` **settings**: `object`

Optional configuration

#### Index Signature

\[`key`: `string`\]: `any`

#### Defined in

[packages/core/src/types.ts:657](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L657)

---

### secrets?

> `optional` **secrets**: `object`

Optional secrets

#### Index Signature

\[`key`: `string`\]: `string` \| `number` \| `boolean`

#### Defined in

[packages/core/src/types.ts:662](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L662)

---

### style?

> `optional` **style**: `object`

Writing style guides

#### all?

> `optional` **all**: `string`[]

#### chat?

> `optional` **chat**: `string`[]

#### post?

> `optional` **post**: `string`[]

#### Defined in

[packages/core/src/types.ts:667](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L667)
```

## File: packages/docs/api/interfaces/Content.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Content

# Interface: Content

Represents the content of a memory, message, or other information

## Indexable

\[`key`: `string`\]: `unknown`

## Properties

### thought?

> `optional` **thought**: `string`

The agent's internal thought process

#### Defined in

[packages/core/src/types.ts:27](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L27)

---

### text?

> `optional` **text**: `string`

The main text content visible to users

#### Defined in

[packages/core/src/types.ts:30](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L30)

---

### actions?

> `optional` **actions**: `string`[]

Optional actions to be performed

#### Defined in

[packages/core/src/types.ts:33](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L33)

---

### providers?

> `optional` **providers**: `string`[]

Optional providers to use for context generation

#### Defined in

[packages/core/src/types.ts:36](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L36)

---

### source?

> `optional` **source**: `string`

Optional source/origin of the content

#### Defined in

[packages/core/src/types.ts:39](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L39)

---

### url?

> `optional` **url**: `string`

URL of the original message/post (e.g. tweet URL, Discord message link)

#### Defined in

[packages/core/src/types.ts:42](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L42)

---

### inReplyTo?

> `optional` **inReplyTo**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

UUID of parent message if this is a reply/thread

#### Defined in

[packages/core/src/types.ts:45](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L45)

---

### attachments?

> `optional` **attachments**: [`Media`](../type-aliases/Media.md)[]

Array of media attachments

#### Defined in

[packages/core/src/types.ts:48](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L48)
```

## File: packages/docs/api/interfaces/ControlMessage.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ControlMessage

# Interface: ControlMessage

Interface for control messages sent from the backend to the frontend
to manage UI state and interaction capabilities

## Properties

### type

> **type**: `"control"`

Message type identifier

#### Defined in

[packages/core/src/types.ts:1977](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1977)

---

### payload

> **payload**: `object`

Control message payload

#### Index Signature

\[`key`: `string`\]: `unknown`

#### action

> **action**: `"disable_input"` \| `"enable_input"`

Action to perform

#### target?

> `optional` **target**: `string`

Optional target element identifier

#### Defined in

[packages/core/src/types.ts:1980](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1980)

---

### roomId

> **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Room ID to ensure signal is directed to the correct chat window

#### Defined in

[packages/core/src/types.ts:1992](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1992)
```

## File: packages/docs/api/interfaces/DetokenizeTextParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / DetokenizeTextParams

# Interface: DetokenizeTextParams

Parameters for text detokenization models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### tokens

> **tokens**: `number`[]

The tokens to convert back to text

#### Defined in

[packages/core/src/types.ts:1147](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1147)

---

### modelType

> **modelType**: `string`

The model type to use for detokenization

#### Defined in

[packages/core/src/types.ts:1148](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1148)

---

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)
```

## File: packages/docs/api/interfaces/EmbeddingSearchResult.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EmbeddingSearchResult

# Interface: EmbeddingSearchResult

Result interface for embedding similarity searches
```

## File: packages/docs/api/interfaces/EnhancedState.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EnhancedState

# Interface: EnhancedState

Enhanced State interface with more specific types
```

## File: packages/docs/api/interfaces/Entity.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Entity

# Interface: Entity

Represents a user account

## Properties

### id?

> `optional` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Unique identifier, optional on creation

#### Defined in

[packages/core/src/types.ts:420](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L420)

---

### names

> **names**: `string`[]

Names of the entity

#### Defined in

[packages/core/src/types.ts:423](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L423)

---

### metadata?

> `optional` **metadata**: `object`

Optional additional metadata

#### Index Signature

\[`key`: `string`\]: `any`

#### Defined in

[packages/core/src/types.ts:426](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L426)

---

### agentId

> **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Agent ID this account is related to, for agents should be themselves

#### Defined in

[packages/core/src/types.ts:429](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L429)

---

### components?

> `optional` **components**: `Component`[]

Optional array of components

#### Defined in

[packages/core/src/types.ts:432](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L432)
```

## File: packages/docs/api/interfaces/EntityPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EntityPayload

# Interface: EntityPayload

Payload for entity-related events

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/EvaluationExample.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EvaluationExample

# Interface: EvaluationExample

Example for evaluating agent behavior

## Properties

### prompt

> **prompt**: `string`

Evaluation context

#### Defined in

[packages/core/src/types.ts:302](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L302)

---

### messages

> **messages**: [`ActionExample`](ActionExample.md)[]

Example messages

#### Defined in

[packages/core/src/types.ts:305](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L305)

---

### outcome

> **outcome**: `string`

Expected outcome

#### Defined in

[packages/core/src/types.ts:308](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L308)
```

## File: packages/docs/api/interfaces/Evaluator.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Evaluator

# Interface: Evaluator

Evaluator for assessing agent responses

## Properties

### alwaysRun?

> `optional` **alwaysRun**: `boolean`

Whether to always run

#### Defined in

[packages/core/src/types.ts:316](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L316)

---

### description

> **description**: `string`

Detailed description

#### Defined in

[packages/core/src/types.ts:319](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L319)

---

### similes?

> `optional` **similes**: `string`[]

Similar evaluator descriptions

#### Defined in

[packages/core/src/types.ts:322](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L322)

---

### examples

> **examples**: [`EvaluationExample`](EvaluationExample.md)[]

Example evaluations

#### Defined in

[packages/core/src/types.ts:325](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L325)

---

### handler

> **handler**: [`Handler`](../type-aliases/Handler.md)

Handler function

#### Defined in

[packages/core/src/types.ts:328](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L328)

---

### name

> **name**: `string`

Evaluator name

#### Defined in

[packages/core/src/types.ts:331](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L331)

---

### validate

> **validate**: [`Validator`](../type-aliases/Validator.md)

Validation function

#### Defined in

[packages/core/src/types.ts:334](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L334)
```

## File: packages/docs/api/interfaces/EvaluatorEventPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EvaluatorEventPayload

# Interface: EvaluatorEventPayload

Evaluator event payload type

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/EventPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EventPayload

# Interface: EventPayload

Base payload interface for all events

## Extended by

- [`WorldPayload`](WorldPayload.md)
- [`EntityPayload`](EntityPayload.md)
- [`MessagePayload`](MessagePayload.md)
- [`InvokePayload`](InvokePayload.md)
- [`RunEventPayload`](RunEventPayload.md)
- [`ActionEventPayload`](ActionEventPayload.md)
- [`EvaluatorEventPayload`](EvaluatorEventPayload.md)
- [`ModelEventPayload`](ModelEventPayload.md)
```

## File: packages/docs/api/interfaces/EventPayloadMap.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EventPayloadMap

# Interface: EventPayloadMap

Maps event types to their corresponding payload types
```

## File: packages/docs/api/interfaces/IDatabaseAdapter.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / IDatabaseAdapter

# Interface: IDatabaseAdapter

Interface for database operations

## Properties

### db

> **db**: `any`

Database instance

#### Defined in

[packages/core/src/types.ts:691](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L691)

## Methods

### init()

> **init**(): `Promise`\<`void`\>

Initialize database connection

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:694](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L694)

---

### close()

> **close**(): `Promise`\<`void`\>

Close database connection

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:697](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L697)

---

### getAgents()

> **getAgents**(): `Promise`\<`Agent`[]\>

Get all agents

#### Returns

`Promise`\<`Agent`[]\>

#### Defined in

[packages/core/src/types.ts:702](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L702)

---

### getEntityById()

> **getEntityById**(`entityId`): `Promise`\<[`Entity`](Entity.md)\>

Get entity by ID

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<[`Entity`](Entity.md)\>

#### Defined in

[packages/core/src/types.ts:715](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L715)

---

### getEntitiesForRoom()

> **getEntitiesForRoom**(`roomId`, `includeComponents`?): `Promise`\<[`Entity`](Entity.md)[]\>

Get entities for room

#### Parameters

• **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **includeComponents?**: `boolean`

#### Returns

`Promise`\<[`Entity`](Entity.md)[]\>

#### Defined in

[packages/core/src/types.ts:718](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L718)

---

### createEntity()

> **createEntity**(`entity`): `Promise`\<`boolean`\>

Create new entity

#### Parameters

• **entity**: [`Entity`](Entity.md)

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[packages/core/src/types.ts:721](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L721)

---

### updateEntity()

> **updateEntity**(`entity`): `Promise`\<`void`\>

Update entity

#### Parameters

• **entity**: [`Entity`](Entity.md)

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:724](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L724)

---

### getComponent()

> **getComponent**(`entityId`, `type`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`\>

Get component by ID

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **type**: `string`

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`Component`\>

#### Defined in

[packages/core/src/types.ts:727](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L727)

---

### getComponents()

> **getComponents**(`entityId`, `worldId`?, `sourceEntityId`?): `Promise`\<`Component`[]\>

Get all components for an entity

#### Parameters

• **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **worldId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **sourceEntityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`Component`[]\>

#### Defined in

[packages/core/src/types.ts:735](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L735)

---

### createComponent()

> **createComponent**(`component`): `Promise`\<`boolean`\>

Create component

#### Parameters

• **component**: `Component`

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[packages/core/src/types.ts:738](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L738)

---

### updateComponent()

> **updateComponent**(`component`): `Promise`\<`void`\>

Update component

#### Parameters

• **component**: `Component`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:741](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L741)

---

### deleteComponent()

> **deleteComponent**(`componentId`): `Promise`\<`void`\>

Delete component

#### Parameters

• **componentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<`void`\>

#### Defined in

[packages/core/src/types.ts:744](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L744)

---

### getMemories()

> **getMemories**(`params`): `Promise`\<[`Memory`](Memory.md)[]\>

Get memories matching criteria

#### Parameters

• **params**

• **params.entityId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.agentId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.roomId?**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.count?**: `number`

• **params.unique?**: `boolean`

• **params.tableName**: `string`

• **params.start?**: `number`

• **params.end?**: `number`

#### Returns

`Promise`\<[`Memory`](Memory.md)[]\>

#### Defined in

[packages/core/src/types.ts:747](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L747)

---

### createRelationship()

> **createRelationship**(`params`): `Promise`\<`boolean`\>

Creates a new relationship between two entities.

#### Parameters

• **params**

Object containing the relationship details

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

• **params.metadata?**

#### Returns

`Promise`\<`boolean`\>

Promise resolving to boolean indicating success

#### Defined in

[packages/core/src/types.ts:856](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L856)

---

### updateRelationship()

> **updateRelationship**(`relationship`): `Promise`\<`void`\>

Updates an existing relationship between two entities.

#### Parameters

• **relationship**: [`Relationship`](Relationship.md)

The relationship object with updated data

#### Returns

`Promise`\<`void`\>

Promise resolving to void

#### Defined in

[packages/core/src/types.ts:868](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L868)

---

### getRelationship()

> **getRelationship**(`params`): `Promise`\<[`Relationship`](Relationship.md)\>

Retrieves a relationship between two entities if it exists.

#### Parameters

• **params**

Object containing the entity IDs and agent ID

• **params.sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

#### Returns

`Promise`\<[`Relationship`](Relationship.md)\>

Promise resolving to the Relationship object or null if not found

#### Defined in

[packages/core/src/types.ts:875](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L875)

---

### getRelationships()

> **getRelationships**(`params`): `Promise`\<[`Relationship`](Relationship.md)[]\>

Retrieves all relationships for a specific entity.

#### Parameters

• **params**

Object containing the user ID, agent ID and optional tags to filter by

• **params.entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

• **params.tags?**: `string`[]

#### Returns

`Promise`\<[`Relationship`](Relationship.md)[]\>

Promise resolving to an array of Relationship objects

#### Defined in

[packages/core/src/types.ts:885](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L885)
```

## File: packages/docs/api/interfaces/ImageDescriptionParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ImageDescriptionParams

# Interface: ImageDescriptionParams

Parameters for image description models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### imageUrl

> **imageUrl**: `string`

The URL or path of the image to describe

#### Defined in

[packages/core/src/types.ts:1377](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1377)

---

### prompt?

> `optional` **prompt**: `string`

Optional prompt to guide the description

#### Defined in

[packages/core/src/types.ts:1379](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1379)
```

## File: packages/docs/api/interfaces/ImageGenerationParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ImageGenerationParams

# Interface: ImageGenerationParams

Parameters for image generation models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### prompt

> **prompt**: `string`

The prompt describing the image to generate

#### Defined in

[packages/core/src/types.ts:1365](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1365)

---

### size?

> `optional` **size**: `string`

The dimensions of the image to generate

#### Defined in

[packages/core/src/types.ts:1367](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1367)

---

### count?

> `optional` **count**: `number`

Number of images to generate

#### Defined in

[packages/core/src/types.ts:1369](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1369)
```

## File: packages/docs/api/interfaces/InvokePayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / InvokePayload

# Interface: InvokePayload

Payload for events that are invoked without a message

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/Log.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Log

# Interface: Log

Represents a log entry

## Properties

### id?

> `optional` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional unique identifier

#### Defined in

[packages/core/src/types.ts:219](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L219)

---

### entityId

> **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated entity ID

#### Defined in

[packages/core/src/types.ts:222](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L222)

---

### roomId?

> `optional` **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated room ID

#### Defined in

[packages/core/src/types.ts:225](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L225)

---

### body

> **body**: `object`

Log body

#### Index Signature

\[`key`: `string`\]: `unknown`

#### Defined in

[packages/core/src/types.ts:228](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L228)

---

### type

> **type**: `string`

Log type

#### Defined in

[packages/core/src/types.ts:231](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L231)

---

### createdAt

> **createdAt**: `Date`

Log creation timestamp

#### Defined in

[packages/core/src/types.ts:234](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L234)
```

## File: packages/docs/api/interfaces/Memory.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Memory

# Interface: Memory

Represents a stored memory/message

## Extended by

- [`MessageMemory`](MessageMemory.md)

## Properties

### id?

> `optional` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional unique identifier

#### Defined in

[packages/core/src/types.ts:184](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L184)

---

### entityId

> **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated user ID

#### Defined in

[packages/core/src/types.ts:187](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L187)

---

### agentId?

> `optional` **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated agent ID

#### Defined in

[packages/core/src/types.ts:190](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L190)

---

### createdAt?

> `optional` **createdAt**: `number`

Optional creation timestamp in milliseconds since epoch

#### Defined in

[packages/core/src/types.ts:193](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L193)

---

### content

> **content**: [`Content`](Content.md)

Memory content

#### Defined in

[packages/core/src/types.ts:196](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L196)

---

### embedding?

> `optional` **embedding**: `number`[]

Optional embedding vector for semantic search

#### Defined in

[packages/core/src/types.ts:199](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L199)

---

### roomId

> **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated room ID

#### Defined in

[packages/core/src/types.ts:202](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L202)

---

### unique?

> `optional` **unique**: `boolean`

Whether memory is unique (used to prevent duplicates)

#### Defined in

[packages/core/src/types.ts:205](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L205)

---

### similarity?

> `optional` **similarity**: `number`

Embedding similarity score (set when retrieved via search)

#### Defined in

[packages/core/src/types.ts:208](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L208)

---

### metadata?

> `optional` **metadata**: `MemoryMetadata`

Metadata for the memory

#### Defined in

[packages/core/src/types.ts:211](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L211)
```

## File: packages/docs/api/interfaces/MemoryRetrievalOptions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MemoryRetrievalOptions

# Interface: MemoryRetrievalOptions

Options for memory retrieval operations
```

## File: packages/docs/api/interfaces/MemorySearchOptions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MemorySearchOptions

# Interface: MemorySearchOptions

Options for memory search operations
```

## File: packages/docs/api/interfaces/MessageExample.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MessageExample

# Interface: MessageExample

Example message for demonstration

## Properties

### name

> **name**: `string`

Associated user

#### Defined in

[packages/core/src/types.ts:242](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L242)

---

### content

> **content**: [`Content`](Content.md)

Message content

#### Defined in

[packages/core/src/types.ts:245](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L245)
```

## File: packages/docs/api/interfaces/MessageMemory.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MessageMemory

# Interface: MessageMemory

Specialized memory type for messages with enhanced type checking

## Extends

- [`Memory`](Memory.md)

## Properties

### id?

> `optional` **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Optional unique identifier

#### Inherited from

[`Memory`](Memory.md).[`id`](Memory.md#id)

#### Defined in

[packages/core/src/types.ts:184](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L184)

---

### entityId

> **entityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated user ID

#### Inherited from

[`Memory`](Memory.md).[`entityId`](Memory.md#entityId)

#### Defined in

[packages/core/src/types.ts:187](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L187)

---

### agentId?

> `optional` **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated agent ID

#### Inherited from

[`Memory`](Memory.md).[`agentId`](Memory.md#agentId)

#### Defined in

[packages/core/src/types.ts:190](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L190)

---

### createdAt?

> `optional` **createdAt**: `number`

Optional creation timestamp in milliseconds since epoch

#### Inherited from

[`Memory`](Memory.md).[`createdAt`](Memory.md#createdAt)

#### Defined in

[packages/core/src/types.ts:193](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L193)

---

### embedding?

> `optional` **embedding**: `number`[]

Optional embedding vector for semantic search

#### Inherited from

[`Memory`](Memory.md).[`embedding`](Memory.md#embedding)

#### Defined in

[packages/core/src/types.ts:199](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L199)

---

### roomId

> **roomId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Associated room ID

#### Inherited from

[`Memory`](Memory.md).[`roomId`](Memory.md#roomId)

#### Defined in

[packages/core/src/types.ts:202](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L202)

---

### unique?

> `optional` **unique**: `boolean`

Whether memory is unique (used to prevent duplicates)

#### Inherited from

[`Memory`](Memory.md).[`unique`](Memory.md#unique)

#### Defined in

[packages/core/src/types.ts:205](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L205)

---

### similarity?

> `optional` **similarity**: `number`

Embedding similarity score (set when retrieved via search)

#### Inherited from

[`Memory`](Memory.md).[`similarity`](Memory.md#similarity)

#### Defined in

[packages/core/src/types.ts:208](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L208)

---

### metadata

> **metadata**: `MessageMetadata`

Metadata for the memory

#### Overrides

[`Memory`](Memory.md).[`metadata`](Memory.md#metadata)

#### Defined in

[packages/core/src/types.ts:1726](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1726)

---

### content

> **content**: [`Content`](Content.md) & `object`

Memory content

#### Type declaration

##### text

> **text**: `string`

#### Overrides

[`Memory`](Memory.md).[`content`](Memory.md#content)

#### Defined in

[packages/core/src/types.ts:1727](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1727)
```

## File: packages/docs/api/interfaces/MessagePayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MessagePayload

# Interface: MessagePayload

Payload for reaction-related events

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/ModelEventPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ModelEventPayload

# Interface: ModelEventPayload

Model event payload type

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/ModelParamsMap.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ModelParamsMap

# Interface: ModelParamsMap

Map of model types to their parameter types
```

## File: packages/docs/api/interfaces/ModelResultMap.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ModelResultMap

# Interface: ModelResultMap

Map of model types to their return value types
```

## File: packages/docs/api/interfaces/MultiRoomMemoryOptions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MultiRoomMemoryOptions

# Interface: MultiRoomMemoryOptions

Options for multi-room memory retrieval
```

## File: packages/docs/api/interfaces/ObjectGenerationParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ObjectGenerationParams

# Interface: ObjectGenerationParams\<T\>

Parameters for object generation models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Type Parameters

• **T** = `any`

The expected return type, inferred from schema if provided

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### prompt

> **prompt**: `string`

The prompt describing the object to generate

#### Defined in

[packages/core/src/types.ts:1441](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1441)

---

### schema?

> `optional` **schema**: [`JSONSchema`](../type-aliases/JSONSchema.md)

Optional JSON schema for validation

#### Defined in

[packages/core/src/types.ts:1443](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1443)

---

### output?

> `optional` **output**: `"object"` \| `"array"` \| `"enum"`

Type of object to generate

#### Defined in

[packages/core/src/types.ts:1445](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1445)

---

### enumValues?

> `optional` **enumValues**: `string`[]

For enum type, the allowed values

#### Defined in

[packages/core/src/types.ts:1447](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1447)

---

### modelType?

> `optional` **modelType**: `string`

Model type to use

#### Defined in

[packages/core/src/types.ts:1449](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1449)

---

### temperature?

> `optional` **temperature**: `number`

Model temperature (0.0 to 1.0)

#### Defined in

[packages/core/src/types.ts:1451](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1451)

---

### stopSequences?

> `optional` **stopSequences**: `string`[]

Sequences that should stop generation

#### Defined in

[packages/core/src/types.ts:1453](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1453)
```

## File: packages/docs/api/interfaces/Participant.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Participant

# Interface: Participant

Room participant with account details

## Properties

### id

> **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Unique identifier

#### Defined in

[packages/core/src/types.ts:468](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L468)

---

### entity

> **entity**: [`Entity`](Entity.md)

Associated account

#### Defined in

[packages/core/src/types.ts:471](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L471)
```

## File: packages/docs/api/interfaces/Plugin.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Plugin

# Interface: Plugin

Plugin for extending agent functionality
```

## File: packages/docs/api/interfaces/Provider.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Provider

# Interface: Provider

Provider for external data/services

## Properties

### name

> **name**: `string`

Provider name

#### Defined in

[packages/core/src/types.ts:352](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L352)

---

### description?

> `optional` **description**: `string`

Description of the provider

#### Defined in

[packages/core/src/types.ts:355](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L355)

---

### dynamic?

> `optional` **dynamic**: `boolean`

Whether the provider is dynamic

#### Defined in

[packages/core/src/types.ts:358](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L358)

---

### position?

> `optional` **position**: `number`

Position of the provider in the provider list, positive or negative

#### Defined in

[packages/core/src/types.ts:361](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L361)

---

### private?

> `optional` **private**: `boolean`

Whether the provider is private

Private providers are not displayed in the regular provider list, they have to be called explicitly

#### Defined in

[packages/core/src/types.ts:368](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L368)

---

### get()

> **get**: (`runtime`, `message`, `state`) => `Promise`\<`ProviderResult`\>

Data retrieval function

#### Parameters

• **runtime**: `IAgentRuntime`

• **message**: [`Memory`](Memory.md)

• **state**: [`State`](State.md)

#### Returns

`Promise`\<`ProviderResult`\>

#### Defined in

[packages/core/src/types.ts:371](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L371)
```

## File: packages/docs/api/interfaces/Relationship.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Relationship

# Interface: Relationship

Represents a relationship between users

## Properties

### id

> **id**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Unique identifier

#### Defined in

[packages/core/src/types.ts:379](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L379)

---

### sourceEntityId

> **sourceEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

First user ID

#### Defined in

[packages/core/src/types.ts:382](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L382)

---

### targetEntityId

> **targetEntityId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Second user ID

#### Defined in

[packages/core/src/types.ts:385](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L385)

---

### agentId

> **agentId**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Agent ID

#### Defined in

[packages/core/src/types.ts:388](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L388)

---

### tags

> **tags**: `string`[]

Tags for filtering/categorizing relationships

#### Defined in

[packages/core/src/types.ts:391](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L391)

---

### metadata

> **metadata**: `object`

Additional metadata about the relationship

#### Index Signature

\[`key`: `string`\]: `any`

#### Defined in

[packages/core/src/types.ts:394](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L394)

---

### createdAt?

> `optional` **createdAt**: `string`

Optional creation timestamp

#### Defined in

[packages/core/src/types.ts:399](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L399)
```

## File: packages/docs/api/interfaces/RunEventPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / RunEventPayload

# Interface: RunEventPayload

Run event payload type

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/interfaces/RuntimeSettings.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / RuntimeSettings

# Interface: RuntimeSettings

Interface representing settings with string key-value pairs.
```

## File: packages/docs/api/interfaces/ServerOwnershipState.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ServerOwnershipState

# Interface: ServerOwnershipState

Interface representing the ownership state of servers.
```

## File: packages/docs/api/interfaces/ServiceError.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ServiceError

# Interface: ServiceError

Standardized service error type for consistent error handling
```

## File: packages/docs/api/interfaces/State.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / State

# Interface: State

Represents the current state/context of a conversation

## Indexable

\[`key`: `string`\]: `any`
```

## File: packages/docs/api/interfaces/TextEmbeddingParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TextEmbeddingParams

# Interface: TextEmbeddingParams

Parameters for text embedding models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### text

> **text**: `string`

The text to create embeddings for

#### Defined in

[packages/core/src/types.ts:1337](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1337)
```

## File: packages/docs/api/interfaces/TextGenerationParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TextGenerationParams

# Interface: TextGenerationParams

Parameters for text generation models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### prompt

> **prompt**: `string`

The prompt to generate text from

#### Defined in

[packages/core/src/types.ts:1319](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1319)

---

### temperature?

> `optional` **temperature**: `number`

Model temperature (0.0 to 1.0, lower is more deterministic)

#### Defined in

[packages/core/src/types.ts:1321](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1321)

---

### maxTokens?

> `optional` **maxTokens**: `number`

Maximum number of tokens to generate

#### Defined in

[packages/core/src/types.ts:1323](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1323)

---

### stopSequences?

> `optional` **stopSequences**: `string`[]

Sequences that should stop generation when encountered

#### Defined in

[packages/core/src/types.ts:1325](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1325)

---

### frequencyPenalty?

> `optional` **frequencyPenalty**: `number`

Frequency penalty to apply

#### Defined in

[packages/core/src/types.ts:1327](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1327)

---

### presencePenalty?

> `optional` **presencePenalty**: `number`

Presence penalty to apply

#### Defined in

[packages/core/src/types.ts:1329](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1329)
```

## File: packages/docs/api/interfaces/TextToSpeechParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TextToSpeechParams

# Interface: TextToSpeechParams

Parameters for text-to-speech models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### text

> **text**: `string`

The text to convert to speech

#### Defined in

[packages/core/src/types.ts:1397](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1397)

---

### voice?

> `optional` **voice**: `string`

The voice to use

#### Defined in

[packages/core/src/types.ts:1399](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1399)

---

### speed?

> `optional` **speed**: `number`

The speaking speed

#### Defined in

[packages/core/src/types.ts:1401](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1401)
```

## File: packages/docs/api/interfaces/TokenizeTextParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TokenizeTextParams

# Interface: TokenizeTextParams

Parameters for text tokenization models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### prompt

> **prompt**: `string`

The text to tokenize

#### Defined in

[packages/core/src/types.ts:1142](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1142)

---

### modelType

> **modelType**: `string`

The model type to use for tokenization

#### Defined in

[packages/core/src/types.ts:1143](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1143)

---

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)
```

## File: packages/docs/api/interfaces/TranscriptionParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TranscriptionParams

# Interface: TranscriptionParams

Parameters for transcription models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### audioUrl

> **audioUrl**: `string`

The URL or path of the audio file to transcribe

#### Defined in

[packages/core/src/types.ts:1387](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1387)

---

### prompt?

> `optional` **prompt**: `string`

Optional prompt to guide transcription

#### Defined in

[packages/core/src/types.ts:1389](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1389)
```

## File: packages/docs/api/interfaces/TypedService.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / TypedService

# Interface: TypedService\<ConfigType, ResultType\>

Generic service interface that provides better type checking for services

## Extends

- [`Service`](../classes/Service.md)

## Type Parameters

• **ConfigType** = `unknown`

The configuration type for this service

• **ResultType** = `unknown`

The result type returned by the service operations

## Properties

### runtime

> `protected` **runtime**: `IAgentRuntime`

Runtime instance

#### Inherited from

[`Service`](../classes/Service.md).[`runtime`](../classes/Service.md#runtime)

#### Defined in

[packages/core/src/types.ts:519](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L519)

---

### capabilityDescription

> `abstract` **capabilityDescription**: `string`

Service name

#### Inherited from

[`Service`](../classes/Service.md).[`capabilityDescription`](../classes/Service.md#capabilityDescription)

#### Defined in

[packages/core/src/types.ts:533](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L533)

---

### config

> **config**: `ConfigType`

The configuration for this service instance

#### Overrides

[`Service`](../classes/Service.md).[`config`](../classes/Service.md#config)

#### Defined in

[packages/core/src/types.ts:1763](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1763)

## Methods

### process()

> **process**(`input`): `Promise`\<`ResultType`\>

Process an input with this service

#### Parameters

• **input**: `unknown`

The input to process

#### Returns

`Promise`\<`ResultType`\>

A promise resolving to the result

#### Defined in

[packages/core/src/types.ts:1770](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1770)
```

## File: packages/docs/api/interfaces/UnifiedMemoryOptions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / UnifiedMemoryOptions

# Interface: UnifiedMemoryOptions

Unified options pattern for memory operations
Provides a simpler, more consistent interface

## Extended by

- [`UnifiedSearchOptions`](UnifiedSearchOptions.md)
```

## File: packages/docs/api/interfaces/UnifiedSearchOptions.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / UnifiedSearchOptions

# Interface: UnifiedSearchOptions

Specialized memory search options

## Extends

- [`UnifiedMemoryOptions`](UnifiedMemoryOptions.md)
```

## File: packages/docs/api/interfaces/VideoProcessingParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / VideoProcessingParams

# Interface: VideoProcessingParams

Parameters for video processing models

## Extends

- [`BaseModelParams`](BaseModelParams.md)

## Properties

### runtime

> **runtime**: `IAgentRuntime`

The agent runtime for accessing services and utilities

#### Inherited from

[`BaseModelParams`](BaseModelParams.md).[`runtime`](BaseModelParams.md#runtime)

#### Defined in

[packages/core/src/types.ts:1311](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1311)

---

### videoUrl

> **videoUrl**: `string`

The URL or path of the video file to process

#### Defined in

[packages/core/src/types.ts:1419](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1419)

---

### processingType

> **processingType**: `string`

The type of video processing to perform

#### Defined in

[packages/core/src/types.ts:1421](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1421)
```

## File: packages/docs/api/interfaces/WorldPayload.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / WorldPayload

# Interface: WorldPayload

Payload for world-related events

## Extends

- [`EventPayload`](EventPayload.md)
```

## File: packages/docs/api/type-aliases/EventHandler.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / EventHandler

# Type Alias: EventHandler()\<T\>

> **EventHandler**\<`T`\>: (`payload`) => `Promise`\<`void`\>

Event handler function type

## Type Parameters

• **T** _extends_ keyof [`EventPayloadMap`](../interfaces/EventPayloadMap.md)

## Parameters

• **payload**: [`EventPayloadMap`](../interfaces/EventPayloadMap.md)\[`T`\]

## Returns

`Promise`\<`void`\>

## Defined in

[packages/core/src/types.ts:1705](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1705)
```

## File: packages/docs/api/type-aliases/Handler.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Handler

# Type Alias: Handler()

> **Handler**: (`runtime`, `message`, `state`?, `options`?, `callback`?, `responses`?) => `Promise`\<`unknown`\>

Handler function type for processing messages

## Parameters

• **runtime**: `IAgentRuntime`

• **message**: [`Memory`](../interfaces/Memory.md)

• **state?**: [`State`](../interfaces/State.md)

• **options?**

• **callback?**: [`HandlerCallback`](HandlerCallback.md)

• **responses?**: [`Memory`](../interfaces/Memory.md)[]

## Returns

`Promise`\<`unknown`\>

## Defined in

[packages/core/src/types.ts:251](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L251)
```

## File: packages/docs/api/type-aliases/HandlerCallback.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / HandlerCallback

# Type Alias: HandlerCallback()

> **HandlerCallback**: (`response`, `files`?) => `Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

Callback function type for handlers

## Parameters

• **response**: [`Content`](../interfaces/Content.md)

• **files?**: `any`

## Returns

`Promise`\<[`Memory`](../interfaces/Memory.md)[]\>

## Defined in

[packages/core/src/types.ts:263](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L263)
```

## File: packages/docs/api/type-aliases/JSONSchema.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / JSONSchema

# Type Alias: JSONSchema

> **JSONSchema**: `object`

Optional JSON schema for validating generated objects

## Index Signature

\[`key`: `string`\]: `any`

## Type declaration

### type

> **type**: `string`

### properties?

> `optional` **properties**: `Record`\<`string`, `any`\>

### required?

> `optional` **required**: `string`[]

### items?

> `optional` **items**: [`JSONSchema`](JSONSchema.md)

## Defined in

[packages/core/src/types.ts:1427](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1427)
```

## File: packages/docs/api/type-aliases/Media.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Media

# Type Alias: Media

> **Media**: `object`

Represents a media attachment

## Type declaration

### id

> **id**: `string`

Unique identifier

### url

> **url**: `string`

Media URL

### title

> **title**: `string`

Media title

### source

> **source**: `string`

Media source

### description

> **description**: `string`

Media description

### text

> **text**: `string`

Text content

### contentType?

> `optional` **contentType**: `string`

Content type

## Defined in

[packages/core/src/types.ts:477](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L477)
```

## File: packages/docs/api/type-aliases/MemoryTypeAlias.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MemoryTypeAlias

# Type Alias: MemoryTypeAlias

> **MemoryTypeAlias**: `string`

Memory type enumeration for built-in memory types

## Defined in

[packages/core/src/types.ts:127](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L127)
```

## File: packages/docs/api/type-aliases/MessageReceivedHandlerParams.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / MessageReceivedHandlerParams

# Type Alias: MessageReceivedHandlerParams

> **MessageReceivedHandlerParams**: `object`

Represents the parameters for a message received handler.

## Type declaration

### runtime

> **runtime**: `IAgentRuntime`

### message

> **message**: [`Memory`](../interfaces/Memory.md)

### callback

> **callback**: [`HandlerCallback`](HandlerCallback.md)

### onComplete()?

> `optional` **onComplete**: () => `void`

#### Returns

`void`

## Defined in

[packages/core/src/types.ts:1670](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1670)
```

## File: packages/docs/api/type-aliases/StateValue.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / StateValue

# Type Alias: StateValue

> **StateValue**: `string` \| `number` \| `boolean` \| `null` \| `StateObject` \| `StateArray`

Replace 'any' types with more specific types

## Defined in

[packages/core/src/types.ts:1925](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L1925)
```

## File: packages/docs/api/type-aliases/UUID.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / UUID

# Type Alias: UUID

> **UUID**: \`$\{string\}-$\{string\}-$\{string\}-$\{string\}-$\{string\}\`

Defines a custom type UUID representing a universally unique identifier

## Defined in

[packages/core/src/types.ts:8](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L8)
```

## File: packages/docs/api/type-aliases/Validator.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / Validator

# Type Alias: Validator()

> **Validator**: (`runtime`, `message`, `state`?) => `Promise`\<`boolean`\>

Validator function type for actions/evaluators

## Parameters

• **runtime**: `IAgentRuntime`

• **message**: [`Memory`](../interfaces/Memory.md)

• **state?**: [`State`](../interfaces/State.md)

## Returns

`Promise`\<`boolean`\>

## Defined in

[packages/core/src/types.ts:268](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L268)
```

## File: packages/docs/api/variables/ModelType.md

```markdown
[@elizaos/core v1.0.0-beta.34](../index.md) / ModelType

# Variable: ModelType

> `const` **ModelType**: `object`

Model size/type classification

## Type declaration

### SMALL

> `readonly` **SMALL**: `"TEXT_SMALL"` = `'TEXT_SMALL'`

### MEDIUM

> `readonly` **MEDIUM**: `"TEXT_LARGE"` = `'TEXT_LARGE'`

### LARGE

> `readonly` **LARGE**: `"TEXT_LARGE"` = `'TEXT_LARGE'`

### TEXT_SMALL

> `readonly` **TEXT_SMALL**: `"TEXT_SMALL"` = `'TEXT_SMALL'`

### TEXT_LARGE

> `readonly` **TEXT_LARGE**: `"TEXT_LARGE"` = `'TEXT_LARGE'`

### TEXT_EMBEDDING

> `readonly` **TEXT_EMBEDDING**: `"TEXT_EMBEDDING"` = `'TEXT_EMBEDDING'`

### TEXT_TOKENIZER_ENCODE

> `readonly` **TEXT_TOKENIZER_ENCODE**: `"TEXT_TOKENIZER_ENCODE"` = `'TEXT_TOKENIZER_ENCODE'`

### TEXT_TOKENIZER_DECODE

> `readonly` **TEXT_TOKENIZER_DECODE**: `"TEXT_TOKENIZER_DECODE"` = `'TEXT_TOKENIZER_DECODE'`

### TEXT_REASONING_SMALL

> `readonly` **TEXT_REASONING_SMALL**: `"REASONING_SMALL"` = `'REASONING_SMALL'`

### TEXT_REASONING_LARGE

> `readonly` **TEXT_REASONING_LARGE**: `"REASONING_LARGE"` = `'REASONING_LARGE'`

### TEXT_COMPLETION

> `readonly` **TEXT_COMPLETION**: `"TEXT_COMPLETION"` = `'TEXT_COMPLETION'`

### IMAGE

> `readonly` **IMAGE**: `"IMAGE"` = `'IMAGE'`

### IMAGE_DESCRIPTION

> `readonly` **IMAGE_DESCRIPTION**: `"IMAGE_DESCRIPTION"` = `'IMAGE_DESCRIPTION'`

### TRANSCRIPTION

> `readonly` **TRANSCRIPTION**: `"TRANSCRIPTION"` = `'TRANSCRIPTION'`

### TEXT_TO_SPEECH

> `readonly` **TEXT_TO_SPEECH**: `"TEXT_TO_SPEECH"` = `'TEXT_TO_SPEECH'`

### AUDIO

> `readonly` **AUDIO**: `"AUDIO"` = `'AUDIO'`

### VIDEO

> `readonly` **VIDEO**: `"VIDEO"` = `'VIDEO'`

### OBJECT_SMALL

> `readonly` **OBJECT_SMALL**: `"OBJECT_SMALL"` = `'OBJECT_SMALL'`

### OBJECT_LARGE

> `readonly` **OBJECT_LARGE**: `"OBJECT_LARGE"` = `'OBJECT_LARGE'`

## Defined in

[packages/core/src/types.ts:73](https://github.com/elizaOS/eliza/blob/main/packages/core/src/types.ts#L73)
```

## File: packages/docs/api/index.md

```markdown
# @elizaos/core v1.0.0-beta.34

## Enumerations

- [EventType](enumerations/EventType.md)
- [PlatformPrefix](enumerations/PlatformPrefix.md)
- [SOCKET_MESSAGE_TYPE](enumerations/SOCKET_MESSAGE_TYPE.md)

## Classes

- [DatabaseAdapter](classes/DatabaseAdapter.md)
- [AgentRuntime](classes/AgentRuntime.md)
- [Service](classes/Service.md)

## Interfaces

- [ServerOwnershipState](interfaces/ServerOwnershipState.md)
- [Content](interfaces/Content.md)
- [ActionExample](interfaces/ActionExample.md)
- [State](interfaces/State.md)
- [BaseMetadata](interfaces/BaseMetadata.md)
- [Memory](interfaces/Memory.md)
- [Log](interfaces/Log.md)
- [MessageExample](interfaces/MessageExample.md)
- [Action](interfaces/Action.md)
- [EvaluationExample](interfaces/EvaluationExample.md)
- [Evaluator](interfaces/Evaluator.md)
- [Provider](interfaces/Provider.md)
- [Relationship](interfaces/Relationship.md)
- [Entity](interfaces/Entity.md)
- [Participant](interfaces/Participant.md)
- [Plugin](interfaces/Plugin.md)
- [Character](interfaces/Character.md)
- [IDatabaseAdapter](interfaces/IDatabaseAdapter.md)
- [EmbeddingSearchResult](interfaces/EmbeddingSearchResult.md)
- [MemoryRetrievalOptions](interfaces/MemoryRetrievalOptions.md)
- [MemorySearchOptions](interfaces/MemorySearchOptions.md)
- [MultiRoomMemoryOptions](interfaces/MultiRoomMemoryOptions.md)
- [UnifiedMemoryOptions](interfaces/UnifiedMemoryOptions.md)
- [UnifiedSearchOptions](interfaces/UnifiedSearchOptions.md)
- [RuntimeSettings](interfaces/RuntimeSettings.md)
- [TokenizeTextParams](interfaces/TokenizeTextParams.md)
- [DetokenizeTextParams](interfaces/DetokenizeTextParams.md)
- [BaseModelParams](interfaces/BaseModelParams.md)
- [TextGenerationParams](interfaces/TextGenerationParams.md)
- [TextEmbeddingParams](interfaces/TextEmbeddingParams.md)
- [ImageGenerationParams](interfaces/ImageGenerationParams.md)
- [ImageDescriptionParams](interfaces/ImageDescriptionParams.md)
- [TranscriptionParams](interfaces/TranscriptionParams.md)
- [TextToSpeechParams](interfaces/TextToSpeechParams.md)
- [AudioProcessingParams](interfaces/AudioProcessingParams.md)
- [VideoProcessingParams](interfaces/VideoProcessingParams.md)
- [ObjectGenerationParams](interfaces/ObjectGenerationParams.md)
- [ModelParamsMap](interfaces/ModelParamsMap.md)
- [ModelResultMap](interfaces/ModelResultMap.md)
- [EventPayload](interfaces/EventPayload.md)
- [WorldPayload](interfaces/WorldPayload.md)
- [EntityPayload](interfaces/EntityPayload.md)
- [MessagePayload](interfaces/MessagePayload.md)
- [InvokePayload](interfaces/InvokePayload.md)
- [RunEventPayload](interfaces/RunEventPayload.md)
- [ActionEventPayload](interfaces/ActionEventPayload.md)
- [EvaluatorEventPayload](interfaces/EvaluatorEventPayload.md)
- [ModelEventPayload](interfaces/ModelEventPayload.md)
- [EventPayloadMap](interfaces/EventPayloadMap.md)
- [MessageMemory](interfaces/MessageMemory.md)
- [TypedService](interfaces/TypedService.md)
- [ServiceError](interfaces/ServiceError.md)
- [EnhancedState](interfaces/EnhancedState.md)
- [ControlMessage](interfaces/ControlMessage.md)

## Type Aliases

- [UUID](type-aliases/UUID.md)
- [MemoryTypeAlias](type-aliases/MemoryTypeAlias.md)
- [Handler](type-aliases/Handler.md)
- [HandlerCallback](type-aliases/HandlerCallback.md)
- [Validator](type-aliases/Validator.md)
- [Media](type-aliases/Media.md)
- [JSONSchema](type-aliases/JSONSchema.md)
- [MessageReceivedHandlerParams](type-aliases/MessageReceivedHandlerParams.md)
- [EventHandler](type-aliases/EventHandler.md)
- [StateValue](type-aliases/StateValue.md)

## Variables

- [ModelType](variables/ModelType.md)

## Functions

- [composeActionExamples](functions/composeActionExamples.md)
- [formatActionNames](functions/formatActionNames.md)
- [formatActions](functions/formatActions.md)
- [getWavHeader](functions/getWavHeader.md)
- [prependWavHeader](functions/prependWavHeader.md)
- [findEntityByName](functions/findEntityByName.md)
- [createUniqueUuid](functions/createUniqueUuid.md)
- [getEntityDetails](functions/getEntityDetails.md)
- [formatEntities](functions/formatEntities.md)
- [composePrompt](functions/composePrompt.md)
- [composePromptFromState](functions/composePromptFromState.md)
- [addHeader](functions/addHeader.md)
- [composeRandomUser](functions/composeRandomUser.md)
- [formatMessages](functions/formatMessages.md)
- [parseBooleanFromText](functions/parseBooleanFromText.md)
- [parseJsonArrayFromText](functions/parseJsonArrayFromText.md)
- [parseJSONObjectFromText](functions/parseJSONObjectFromText.md)
- [extractAttributes](functions/extractAttributes.md)
- [normalizeJsonString](functions/normalizeJsonString.md)
- [cleanJsonResponse](functions/cleanJsonResponse.md)
- [truncateToCompleteSentence](functions/truncateToCompleteSentence.md)
- [trimTokens](functions/trimTokens.md)
- [getUserServerRole](functions/getUserServerRole.md)
- [findWorldsForOwner](functions/findWorldsForOwner.md)
- [createSettingFromConfig](functions/createSettingFromConfig.md)
- [getSalt](functions/getSalt.md)
- [encryptStringValue](functions/encryptStringValue.md)
- [decryptStringValue](functions/decryptStringValue.md)
- [saltSettingValue](functions/saltSettingValue.md)
- [unsaltSettingValue](functions/unsaltSettingValue.md)
- [saltWorldSettings](functions/saltWorldSettings.md)
- [unsaltWorldSettings](functions/unsaltWorldSettings.md)
- [updateWorldSettings](functions/updateWorldSettings.md)
- [getWorldSettings](functions/getWorldSettings.md)
- [initializeOnboarding](functions/initializeOnboarding.md)
- [encryptedCharacter](functions/encryptedCharacter.md)
- [decryptedCharacter](functions/decryptedCharacter.md)
- [encryptObjectValues](functions/encryptObjectValues.md)
- [decryptObjectValues](functions/decryptObjectValues.md)
- [asUUID](functions/asUUID.md)
- [createMessageMemory](functions/createMessageMemory.md)
- [getTypedService](functions/getTypedService.md)
- [isDocumentMetadata](functions/isDocumentMetadata.md)
- [isFragmentMetadata](functions/isFragmentMetadata.md)
- [isMessageMetadata](functions/isMessageMetadata.md)
- [isDescriptionMetadata](functions/isDescriptionMetadata.md)
- [isCustomMetadata](functions/isCustomMetadata.md)
- [getVideoService](functions/getVideoService.md)
- [getBrowserService](functions/getBrowserService.md)
- [getPdfService](functions/getPdfService.md)
- [getFileService](functions/getFileService.md)
- [isDocumentMemory](functions/isDocumentMemory.md)
- [isFragmentMemory](functions/isFragmentMemory.md)
- [getMemoryText](functions/getMemoryText.md)
- [createServiceError](functions/createServiceError.md)
- [validateUuid](functions/validateUuid.md)
- [stringToUuid](functions/stringToUuid.md)
```
