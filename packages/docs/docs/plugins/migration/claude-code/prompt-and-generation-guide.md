# ElizaOS Prompt Composition & Generation Guide - v1.x

> **Important**: This guide provides comprehensive documentation for migrating from `composeContext` to the new prompt composition methods, and from the old generation functions to `useModel`.

## Table of Contents

- [Overview of Changes](#overview-of-changes)
- [Prompt Composition Migration](#prompt-composition-migration)
  - [composeContext → composePrompt/composePromptFromState](#composecontext--composepromptcomposepromptfromstate)
  - [Key Differences](#key-differences)
  - [Migration Examples](#migration-examples)
- [Text Generation Migration](#text-generation-migration)
  - [generateText → useModel](#generatetext--usemodel)
  - [generateObject → useModel](#generateobject--usemodel)
  - [generateMessageResponse → useModel](#generatemessageresponse--usemodel)
- [Template Format Migration](#template-format-migration)
  - [JSON → XML Templates](#json--xml-templates)
  - [Parsing Changes](#parsing-changes)
- [Complete Migration Examples](#complete-migration-examples)
- [Benefits of the New Approach](#benefits-of-the-new-approach)
- [Real-World Migration Example: Gitcoin Passport Score Action](#real-world-migration-example-gitcoin-passport-score-action)

---

## Overview of Changes

The v1 migration introduces several key improvements:

1. **Prompt Composition**: `composeContext` split into two specialized functions
2. **Unified Model Interface**: All generation functions consolidated into `runtime.useModel`
3. **Template Format**: JSON responses replaced with XML for better parsing
4. **Better Type Safety**: Improved TypeScript support throughout

---

## Prompt Composition Migration

### composeContext → composePrompt/composePromptFromState

#### v0: Single composeContext Function

```typescript
// v0: packages/core-0x/src/context.ts
export const composeContext = ({
  state,
  template,
  templatingEngine,
}: {
  state: State;
  template: TemplateType;
  templatingEngine?: 'handlebars';
}) => {
  // Supported both simple replacement and handlebars
  if (templatingEngine === 'handlebars') {
    const templateFunction = handlebars.compile(templateStr);
    return templateFunction(state);
  }
  // Simple {{key}} replacement
  return templateStr.replace(/{{\w+}}/g, (match) => {
    const key = match.replace(/{{|}}/g, '');
    return state[key] ?? '';
  });
};
```

#### v1: Two Specialized Functions

```typescript
// v1: packages/core/src/utils.ts

// For simple key-value state objects
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));
  const output = composeRandomUser(templateFunction(state), 10);
  return output;
};

// For complex State objects from runtime
export const composePromptFromState = ({
  state,
  template,
}: {
  state: State;
  template: TemplateType;
}) => {
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));

  // Intelligent state flattening
  const stateKeys = Object.keys(state);
  const filteredKeys = stateKeys.filter((key) => !['text', 'values', 'data'].includes(key));

  const filteredState = filteredKeys.reduce((acc, key) => {
    acc[key] = state[key];
    return acc;
  }, {});

  // Merges filtered state with state.values
  const output = composeRandomUser(templateFunction({ ...filteredState, ...state.values }), 10);
  return output;
};
```

### Key Differences

1. **Handlebars by Default**: v1 always uses Handlebars (no simple replacement mode)
2. **Auto HTML Escaping**: v1 automatically converts `{{var}}` to `{{{var}}}` to prevent HTML escaping
3. **State Handling**: `composePromptFromState` intelligently flattens complex State objects
4. **Random User Names**: Both functions automatically replace `{{name1}}`, `{{name2}}`, etc. with random names

### Migration Examples

#### Simple State Objects

```typescript
// v0
const prompt = composeContext({
  state: { userName: 'Alice', topic: 'weather' },
  template: "Hello {{userName}}, let's talk about {{topic}}",
});

// v1
const prompt = composePrompt({
  state: { userName: 'Alice', topic: 'weather' },
  template: "Hello {{userName}}, let's talk about {{topic}}",
});
```

#### Complex Runtime State

```typescript
// v0
const prompt = composeContext({
  state: currentState,
  template: messageTemplate,
  templatingEngine: 'handlebars',
});

// v1 - Use composePromptFromState for State objects
const prompt = composePromptFromState({
  state: currentState,
  template: messageTemplate,
});
```

#### Dynamic Templates

```typescript
// v0
const template = ({ state }) => {
  return state.isUrgent ? 'URGENT: {{message}}' : 'Info: {{message}}';
};

const prompt = composeContext({ state, template });

// v1 - Same pattern works
const prompt = composePrompt({ state, template });
```

---

## Text Generation Migration

### generateText → useModel

#### v0: Standalone Function

```typescript
// v0: Using generateText
import { generateText, ModelClass } from '@elizaos/core';

const response = await generateText({
  runtime,
  context: prompt,
  modelClass: ModelClass.SMALL,
  stop: ['\n'],
  temperature: 0.7,
});
```

#### v1: Runtime Method

```typescript
// v1: Using runtime.useModel
import { ModelType } from '@elizaos/core';

const response = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt,
  stopSequences: ['\n'],
  temperature: 0.7,
});
```

### generateObject → useModel

#### v0: Object Generation

```typescript
// v0: Using generateObject
const content = await generateObject({
  runtime,
  context: prompt,
  modelClass: ModelClass.SMALL,
});

// Returned raw object
console.log(content.name, content.value);
```

#### v1: Using useModel with XML

```typescript
// v1: Generate text with XML format
const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt,
});

// Parse XML to object
const content = parseKeyValueXml(xmlResponse);
console.log(content.name, content.value);
```

### generateMessageResponse → useModel

#### v0: Message Response Generation

```typescript
// v0: From getScore.ts example
const addressRequest = await generateMessageResponse({
  runtime,
  context,
  modelClass: ModelClass.SMALL,
});

const address = addressRequest.address as string;
```

#### v1: Using useModel with XML Template

```typescript
// v1: Generate and parse XML response
const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: context,
});

const addressRequest = parseKeyValueXml(xmlResponse);
const address = addressRequest.address as string;
```

---

## Template Format Migration

### JSON → XML Templates

The most significant change is moving from JSON to XML format for structured responses.

#### v0: JSON Template

```typescript
const addressTemplate = `From previous sentence extract only the Ethereum address being asked about.
Respond with a JSON markdown block containing only the extracted value:

\`\`\`json
{
"address": string | null
}
\`\`\`
`;
```

#### v1: XML Template

```typescript
const addressTemplate = `From previous sentence extract only the Ethereum address being asked about.
Respond with an XML block containing only the extracted value:

<response>
<address>extracted_address_here_or_null</address>
</response>
`;
```

### Parsing Changes

#### v0: JSON Parsing

```typescript
// v0: Parse JSON from text
import { parseJSONObjectFromText } from '@elizaos/core';

const parsedContent = parseJSONObjectFromText(response);
if (parsedContent && parsedContent.address) {
  // Use the address
}
```

#### v1: XML Parsing

```typescript
// v1: Parse XML key-value pairs
import { parseKeyValueXml } from '@elizaos/core';

const parsedContent = parseKeyValueXml(response);
if (parsedContent && parsedContent.address) {
  // Use the address
}
```

### Template Examples

#### Complex Object Extraction

```typescript
// v0: JSON Template
const template = `Extract token information from the message.
Return a JSON object:

\`\`\`json
{
  "name": "token name",
  "symbol": "token symbol",
  "supply": "total supply",
  "features": ["feature1", "feature2"]
}
\`\`\``;

// v1: XML Template
const template = `Extract token information from the message.
Return an XML response:

<response>
  <name>token name</name>
  <symbol>token symbol</symbol>
  <supply>total supply</supply>
  <features>feature1,feature2</features>
</response>`;
```

---

## Complete Migration Examples

### Example 1: Simple Action Handler

```typescript
// v0: Old Action Handler
import { composeContext, generateMessageResponse, ModelClass } from '@elizaos/core';

handler: async (runtime, message, state) => {
  // Compose context
  const context = composeContext({
    state,
    template: addressTemplate,
  });

  // Generate response
  const response = await generateMessageResponse({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  });

  const address = response.address;
  // Process address...
};
```

```typescript
// v1: New Action Handler
import { composePromptFromState, parseKeyValueXml, ModelType } from '@elizaos/core';

handler: async (runtime, message, state) => {
  // Compose prompt
  const prompt = composePromptFromState({
    state,
    template: addressTemplate, // Now using XML format
  });

  // Generate response
  const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  // Parse XML
  const response = parseKeyValueXml(xmlResponse);
  const address = response.address;
  // Process address...
};
```

### Example 2: Complex State Handling

```typescript
// v0: Complex Context Building
const context = composeContext({
  state: {
    ...baseState,
    recentMessages: formatMessages(messages),
    userName: user.name,
    customData: JSON.stringify(data),
  },
  template: complexTemplate,
  templatingEngine: 'handlebars',
});

const result = await generateObject({
  runtime,
  context,
  modelClass: ModelClass.LARGE,
});

// v1: Simplified with composePromptFromState
const state = await runtime.composeState(message);
const prompt = composePromptFromState({
  state, // Already contains recentMessages, userName, etc.
  template: complexTemplate,
});

const xmlResult = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt,
});

const result = parseKeyValueXml(xmlResult);
```

### Example 3: Custom Model Parameters

```typescript
// v0: Limited control
const response = await generateText({
  runtime,
  context,
  modelClass: ModelClass.SMALL,
  temperature: 0.7,
  stop: ['\n', 'END'],
  maxTokens: 100,
});

// v1: Full control with useModel
const response = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt,
  temperature: 0.7,
  stopSequences: ['\n', 'END'],
  maxTokens: 100,
  frequencyPenalty: 0.5,
  presencePenalty: 0.5,
  // Any additional model-specific parameters
});
```

---

## Benefits of the New Approach

### 1. Unified Interface

**v0 Problems:**

- Multiple generation functions (`generateText`, `generateObject`, `generateMessageResponse`)
- Inconsistent parameter names
- Different return types

**v1 Solution:**

- Single `useModel` method for all model interactions
- Consistent parameter interface
- Predictable return types

### 2. Better State Management

**v0 Problems:**

- Manual state flattening required
- Confusion between State object and simple key-value objects
- No intelligent handling of nested data

**v1 Solution:**

- `composePromptFromState` intelligently handles State objects
- Automatic flattening of relevant fields
- Preserves state.values for template access

### 3. XML Over JSON

**v0 Problems:**

- JSON parsing often failed with markdown code blocks
- Complex escaping issues
- Inconsistent formatting from LLMs

**v1 Solution:**

- XML is more forgiving and easier to parse
- Better handling of special characters
- More consistent LLM outputs

### 4. Type Safety

**v0 Problems:**

- Loose typing on generation functions
- Runtime errors from type mismatches
- Poor IDE support

**v1 Solution:**

- Strong TypeScript types throughout
- `ModelType` enum for model selection
- Better IDE autocomplete and error detection

### 5. Extensibility

**v0 Problems:**

- Hard-coded model providers
- Limited customization options
- Difficult to add new models

**v1 Solution:**

- Pluggable model system via `runtime.registerModel`
- Easy to add custom model providers
- Standardized model interface

### 6. Performance

**v0 Problems:**

- Multiple parsing attempts for JSON
- Redundant context building
- No caching mechanism

**v1 Solution:**

- Single-pass XML parsing
- Efficient state composition
- Built-in caching support in `composeState`

---

## Real-World Migration Example: Gitcoin Passport Score Action

Here's a complete migration of a real action from the Gitcoin Passport plugin:

### Original v0 Action

```typescript
import {
  type Action,
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type HandlerCallback,
  type State,
  getEmbeddingZeroVector,
  composeContext,
  generateMessageResponse,
  ModelClass,
} from '@elizaos/core';

export const addressTemplate = `From previous sentence extract only the Ethereum address being asked about.
Respond with a JSON markdown block containing only the extracted value:

\`\`\`json
{
"address": string | null
}
\`\`\`
`;

handler: async (runtime, _message, state, _options, callback) => {
  // Initialize or update state
  let currentState = state;
  if (!currentState) {
    currentState = (await runtime.composeState(_message)) as State;
  } else {
    currentState = await runtime.updateRecentMessageState(currentState);
  }

  const context = composeContext({
    state: currentState,
    template: `${_message.content.text}\n${addressTemplate}`,
  });

  const addressRequest = await generateMessageResponse({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  });

  const address = addressRequest.address as string;
  // ... rest of handler
};
```

### Migrated v1 Action

```typescript
import {
  type Action,
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type HandlerCallback,
  type State,
  composePromptFromState,
  parseKeyValueXml,
  ModelType,
} from '@elizaos/core';

export const addressTemplate = `From previous sentence extract only the Ethereum address being asked about.
Respond with an XML block containing only the extracted value:

<response>
<address>extracted_ethereum_address_or_null</address>
</response>
`;

handler: async (runtime, _message, state, _options, callback) => {
  // Initialize or update state
  let currentState = state;
  if (!currentState) {
    currentState = await runtime.composeState(_message);
  } else {
    currentState = await runtime.composeState(_message, ['RECENT_MESSAGES']);
  }

  const prompt = composePromptFromState({
    state: currentState,
    template: `${_message.content.text}\n${addressTemplate}`,
  });

  const xmlResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
  });

  const addressRequest = parseKeyValueXml(xmlResponse);
  const address = addressRequest?.address as string;
  // ... rest of handler
};
```

### Memory Creation Migration

```typescript
// v0: Using deprecated fields
const memory: Memory = {
  userId: _message.userId,
  agentId: _message.agentId,
  roomId: _message.roomId,
  content: { text: formattedOutput },
  createdAt: Date.now(),
  embedding: getEmbeddingZeroVector(),
};
await runtime.messageManager.createMemory(memory);

// v1: Using new structure
const memory: Memory = {
  entityId: _message.entityId,
  agentId: runtime.agentId,
  roomId: _message.roomId,
  content: { text: formattedOutput },
  createdAt: Date.now(),
  // embedding will be added by runtime if needed
};
await runtime.createMemory(memory);
```

### Complete Action Migration Summary

1. **Imports**: Replace old functions with new equivalents
2. **Template**: Convert JSON format to XML
3. **State Management**: Use `composeState` with filtering
4. **Generation**: Replace `generateMessageResponse` with `useModel`
5. **Parsing**: Use `parseKeyValueXml` instead of direct object access
6. **Memory**: Update to use `entityId` and new creation method

---

## Migration Checklist

- [ ] Replace `composeContext` with `composePrompt` or `composePromptFromState`
- [ ] Update all templates from JSON to XML format
- [ ] Replace `generateText` with `runtime.useModel(ModelType.TEXT_*)`
- [ ] Replace `generateObject` with `runtime.useModel` + `parseKeyValueXml`
- [ ] Replace `generateMessageResponse` with `runtime.useModel` + `parseKeyValueXml`
- [ ] Update `ModelClass` to `ModelType` enum values
- [ ] Replace `parseJSONObjectFromText` with `parseKeyValueXml`
- [ ] Update import statements to use new functions
- [ ] Test XML parsing with your specific use cases
- [ ] Consider using state filtering for performance optimization
- [ ] Update Memory objects to use `entityId` instead of `userId`
- [ ] Replace `runtime.updateRecentMessageState` with filtered `composeState`
- [ ] Remove `getEmbeddingZeroVector` - embeddings are handled automatically
