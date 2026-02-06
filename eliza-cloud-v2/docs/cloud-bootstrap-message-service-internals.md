# CloudBootstrapMessageService Internals Documentation

This document explains how the CloudBootstrapMessageService works internally, including the ElizaOS framework methods it uses, the provider system, state composition, and multi-step execution flow. This is intended for Claude or developers who need to understand and optimize the message processing pipeline.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Overview](#architecture-overview)
3. [Key ElizaOS Framework Methods](#key-elizaos-framework-methods)
   - [composeState](#composestate)
   - [composePromptFromState](#composepromptfromstate)
   - [processActions](#processactions)
   - [parseKeyValueXml](#parsekeyvaluexml)
4. [Provider System](#provider-system)
   - [Provider Interface](#provider-interface)
   - [How Providers Are Registered](#how-providers-are-registered)
   - [How composeState Invokes Providers](#how-composestate-invokes-providers)
5. [State Structure](#state-structure)
6. [Key Providers in CloudBootstrap](#key-providers-in-cloudbootstrap)
   - [ACTION_STATE Provider](#action_state-provider)
   - [ACTIONS Provider](#actions-provider)
   - [RECENT_MESSAGES Provider](#recent_messages-provider)
   - [CHARACTER Provider](#character-provider)
7. [Multi-Step Execution Loop](#multi-step-execution-loop)
8. [Template Variable Reference](#template-variable-reference)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [Action Parameter Flow](#action-parameter-flow)

---

## Overview

The `CloudBootstrapMessageService` (`lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts`) is a custom implementation of ElizaOS's `IMessageService` interface for the eliza-cloud-v2 platform. It extends the default message handling with:

- **Multi-step workflow execution**: Iteratively calls LLM to decide on actions, executes them ONE AT A TIME, refreshes state, and repeats
- **Structured parameter extraction**: LLM outputs parameters in XML format, which are parsed and passed to action handlers
- **Race tracking**: Prevents stale responses when newer messages arrive
- **Streaming support**: Real-time streaming of thinking/reasoning updates via SSE
- **Custom templates**: Uses `multiStepDecisionTemplate` and `multiStepSummaryTemplate`
- **Separated prompt architecture**: Decision phase uses functional system prompt (no personality), summary phase uses full character personality

**Key Entry Points**:
- API Route: `POST /api/eliza/rooms/[roomId]/messages/stream` → `route.ts`
- Route → `MessageHandler.process()` → `runtime.messageService.handleMessage()`
- Service: `handleMessage()` → `processMessage()` → `runMultiStepCore()` (or `runSingleShotCore()`)

**Prompt Architecture**:
The multi-step execution uses a two-phase prompt architecture:

1. **Decision Phase** (iterations 1-N): Uses `MULTISTEP_DECISION_SYSTEM` - a purely functional system prompt focused on action selection. No character personality is included. This keeps the LLM focused on understanding the user's request and selecting optimal actions.

2. **Summary Phase**: Uses the character's full system prompt (`runtime.character.system`) plus `{{bio}}` and `{{messageDirections}}` from the CHARACTER provider. This is where the agent's personality and voice come through in the user-facing response.

> **Important**: CloudBootstrap uses its own `traceActionResult[]` array for tracking action results, stored in `state.data.actionResults`. Each iteration calls `processActions()` with **one action at a time**.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              API Layer                                        │
│  POST /api/eliza/rooms/[roomId]/messages/stream                               │
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Authenticate user (Privy/API key/anonymous)                           ││
│  │ 2. Build UserContext (userId, orgId, characterId, modelPrefs)            ││
│  │ 3. Get/create AgentRuntime via RuntimeFactory                            ││
│  │ 4. Create MessageHandler with runtime + userContext                      ││
│  │ 5. Call messageHandler.process() with SSE streaming callbacks            ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           MessageHandler                                      │
│  lib/eliza/message-handler.ts                                                │
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Ensure connection (world, room, entities, participants)               ││
│  │ 2. Create user message Memory object                                     ││
│  │ 3. Call runtime.messageService.handleMessage(runtime, message, callback) ││
│  │ 4. Build response Memory from result                                     ││
│  │ 5. Trigger side-effects (Discord, title generation)                      ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CloudBootstrapMessageService                              │
│  lib/eliza/plugin-cloud-bootstrap/services/cloud-bootstrap-message-service.ts│
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │ handleMessage() → processMessage() → runMultiStepCore()                  ││
│  │                                                                          ││
│  │ Multi-Step Loop (up to 6 iterations):                                    ││
│  │   1. composeState() with RECENT_MESSAGES, ACTION_STATE, ACTIONS          ││
│  │   2. composePromptFromState() with multiStepDecisionTemplate             ││
│  │   3. LLM call (TEXT_LARGE) → parse XML response                          ││
│  │   4. Extract action + parameters from XML                                ││
│  │   5. processActions() with single action                                 ││
│  │   6. Record result in traceActionResult[]                                ││
│  │   7. refreshStateAfterAction() to update providers                       ││
│  │   8. If isFinish=true OR max iterations → exit loop                      ││
│  │                                                                          ││
│  │ Summary Generation:                                                       ││
│  │   1. composeState() with RECENT_MESSAGES, ACTION_STATE                   ││
│  │   2. composePromptFromState() with multiStepSummaryTemplate              ││
│  │   3. LLM call (TEXT_LARGE) → parse XML → return final text               ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Key ElizaOS Framework Methods

### composeState

**Location**: `eliza/packages/core/src/runtime.ts`

**Signature**:
```typescript
async composeState(
  message: Memory,
  includeList: string[] | null = null,
  onlyInclude = false,
  skipCache = false
): Promise<State>
```

**What It Does**:
1. Filters providers based on `includeList` parameter
2. Sorts providers by their `position` property (lower = earlier)
3. Calls each provider's `get()` method **in parallel** via `Promise.all()`
4. Aggregates results into a unified `State` object

**Provider Selection Logic**:
```typescript
// If onlyInclude is true + includeList provided: ONLY those providers
// If onlyInclude is false: all non-private, non-dynamic providers + includeList extras
if (filterList && filterList.length > 0) {
  filterList.forEach((name) => providerNames.add(name));
} else {
  this.providers
    .filter((p) => !p.private && !p.dynamic)
    .forEach((p) => providerNames.add(p.name));
}
```

**Example Usage in CloudBootstrapMessageService**:
```typescript
// Compose state with specific providers for multi-step
const state = await runtime.composeState(message, [
  'RECENT_MESSAGES',
  'ACTION_STATE',
  'ACTIONS',
], true);
```

---

### composePromptFromState

**Location**: `eliza/packages/core/src/utils.ts`

**Signature**:
```typescript
function composePromptFromState(options: {
  state: State;
  template: string;
}): string
```

**What It Does**:
1. Merges `state.values` with top-level state properties into `templateData`
2. Compiles the template using **Handlebars**
3. Returns the populated prompt string

**Implementation**:
```typescript
export function composePromptFromState({
  state,
  template,
}: {
  state: State;
  template: string;
}): string {
  // Merge state.values and other state properties
  const templateData = {
    ...state.values,
    ...Object.fromEntries(
      Object.entries(state).filter(
        ([key]) => key !== 'values' && key !== 'data' && key !== 'text'
      )
    ),
  };

  // Compile and execute Handlebars template
  const compiledTemplate = Handlebars.compile(template);
  return compiledTemplate(templateData);
}
```

**Key Points**:
- `{{variableName}}` in templates are replaced by values from:
  1. `state.values.variableName` (from providers)
  2. Top-level `state.variableName` (if not `values`, `data`, or `text`)
- **Handlebars helpers** like `{{#if}}`, `{{#each}}` are supported
- The `{{providers}}` placeholder gets replaced with the concatenated text from all providers

---

### processActions

**Location**: `eliza/packages/core/src/runtime.ts`

**Signature**:
```typescript
async processActions(
  message: Memory,
  responses: Memory[],
  state?: State,
  callback?: HandlerCallback,
  processOptions?: { onStreamChunk?: (chunk: string, messageId?: UUID) => Promise<void> }
): Promise<void>
```

**What It Does (in CloudBootstrap's single-action-per-call context)**:

CloudBootstrap always calls this with ONE action at a time:
```typescript
runtime.processActions(message, [{
  content: { actions: [action], actionParams, actionInput }
}], state, callback)
```

For each call:
1. Extracts the single action name from `responses[0].content.actions[0]`
2. Finds the matching action definition by normalized name
3. Validates via `action.validate()`
4. Executes via `action.handler()`
5. Stores the single `ActionResult` in cache: `stateCache.set(`${message.id}_action_results`, ...)`

**Action Matching** (normalized):
```typescript
function normalizeAction(actionString: string) {
  return actionString.toLowerCase().replace(/_/g, '');
}
// "WEB_SEARCH" → "websearch"
// "web_search" → "websearch"
```

**Result Caching**:
```typescript
// After action execution, stores to cache
this.stateCache.set(`${message.id}_action_results`, {
  values: { actionResults },      // Array with ONE result
  data: { actionResults },
  text: JSON.stringify(actionResults),
});
```

**How CloudBootstrap Reads Results**:
```typescript
// In CloudBootstrapMessageService, after processActions completes:
const actionResults = getActionResultsFromCache(runtime, message.id);
const result = actionResults[0];  // Gets the single result

// Then manually appends to its own tracking array:
traceActionResult.push({
  data: { actionName: action },
  success: result?.success,
  text: result?.text,
  values: result?.values,
});
```

> **Important**: Each `processActions` call OVERWRITES the cache. CloudBootstrap must read the result immediately after each call before the next iteration overwrites it. This is why CloudBootstrap maintains its own `traceActionResult[]` array.

---

### parseKeyValueXml

**Location**: `eliza/packages/core/src/utils.ts`

**What It Does**:
Parses XML-formatted LLM output like:
```xml
<response>
  <thought>My reasoning here</thought>
  <action>ACTION_NAME</action>
  <parameters>{"key": "value"}</parameters>
  <isFinish>false</isFinish>
</response>
```

**Returns**: `Record<string, unknown> | null`
```typescript
{
  thought: "My reasoning here",
  action: "ACTION_NAME",
  parameters: '{"key": "value"}', // Note: string, needs JSON.parse
  isFinish: "false"               // Note: string, needs boolean conversion
}
```

---

## Provider System

### Provider Interface

**Location**: `eliza/packages/core/src/types/components.ts`

```typescript
interface Provider {
  name: string;                    // Unique identifier (e.g., "ACTION_STATE")
  description?: string;            // Human-readable description
  dynamic?: boolean;               // If true, changes often (not auto-included)
  position?: number;               // Execution order (lower = earlier)
  private?: boolean;               // If true, must be explicitly requested

  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<ProviderResult>;
}

interface ProviderResult {
  text?: string;                   // Human-readable text for {{providers}}
  values?: Record<string, unknown>; // Key-value pairs for template variables
  data?: Record<string, unknown>;   // Structured data for programmatic access
}
```

### How Providers Are Registered

Providers are registered through plugins. The CloudBootstrap plugin exports:

```typescript
// lib/eliza/plugin-cloud-bootstrap/index.ts
export const cloudBootstrapPlugin: Plugin = {
  name: "cloud-bootstrap",
  providers: [
    actionStateProvider,      // position: 150
    actionsProvider,          // position: -1
    characterProvider,        // from shared providers
    recentMessagesProvider,   // position: 94
  ],
  services: [MessageServiceInstaller],
  actions: [generateImageAction],
};
```

During `runtime.initialize()`, all plugin providers are collected into `runtime.providers[]`.

### How composeState Invokes Providers

**Step-by-step**:

1. **Filter providers** by `includeList` or default rules
2. **Sort by position** (ascending, so lower = earlier)
3. **Call `get()` in parallel**:
   ```typescript
   const providerData = await Promise.all(
     providersToGet.map(async (provider) => {
       const result = await provider.get(this, message, cachedState);
       return { ...result, providerName: provider.name };
     })
   );
   ```
4. **Aggregate results**:
   - `text` → concatenated into `state.text` and `state.values.providers`
   - `values` → merged into `state.values`
   - `data` → stored in `state.data.providers[providerName]`

**Final State Structure**:
```typescript
const newState = {
  values: {
    ...aggregatedStateValues,      // All provider values merged
    providers: providersText,       // Concatenated text from all providers
  },
  data: {
    ...(cachedState.data || {}),
    providers: currentProviderResults, // Raw provider results by name
  },
  text: providersText,             // Same as values.providers
};
```

---

## State Structure

```typescript
interface State {
  values: Record<string, unknown>;  // Template variable values
  data: Record<string, unknown>;    // Structured data cache
  text: string;                     // Concatenated provider text
}
```

### state.values

Used by `composePromptFromState` for Handlebars template substitution:

| Key | Source | Description |
|-----|--------|-------------|
| `providers` | All providers | Concatenated text from all providers |
| `actionNames` | ACTIONS provider | Comma-separated list of available actions |
| `actionsWithParams` | ACTIONS provider | Formatted action descriptions with parameter schemas |
| `actionsWithDescriptions` | ACTIONS provider | Formatted actions without params |
| `recentMessages` | RECENT_MESSAGES provider | Formatted conversation history |
| `conversationLog` | RECENT_MESSAGES provider | Simple timestamped log |
| `agentName` | CHARACTER provider | Agent's name |
| `bio` | CHARACTER provider | Agent's biography |
| `system` | CHARACTER provider | System prompt from character |
| `messageDirections` | CHARACTER provider | Message style directions |
| `hasActionResults` | ACTION_STATE provider | Boolean |
| `actionResults` | ACTION_STATE provider | Formatted action results text |
| `completedActions` | ACTION_STATE provider | Count of successful actions |
| `failedActions` | ACTION_STATE provider | Count of failed actions |

### state.data

Used for programmatic access, not template substitution:

| Key | Source | Description |
|-----|--------|-------------|
| `providers` | composeState | Raw provider results keyed by name |
| `actionResults` | Multi-step loop (`traceActionResult`) | Array of action result objects |
| `workingMemory` | Multi-step loop | Key-value store for cross-action data |
| `actionParams` | Multi-step loop | Parameters for current action |

---

## Key Providers in CloudBootstrap

### ACTION_STATE Provider

**Location**: `lib/eliza/plugin-cloud-bootstrap/providers/action-state.ts`

**Purpose**: Makes previous action results available to subsequent actions and LLM decisions.

**Position**: 150 (mid-priority)

**What It Returns**:

```typescript
{
  text: `
# Previous Action Results
**1. WEB_SEARCH** - Success
   Output: Based on the search results, Hyperliquid's HYPE token surged 25%...
   Values:
   - query: "Hyperliquid news"
   - resultsFound: 5

**2. WEB_SEARCH** - Success
   Output: PumpFun token has experienced significant activity...

# Working Memory
**lastSearchQuery**: "PumpFun token news crypto"
`,
  values: {
    hasActionResults: true,
    actionResults: "... formatted text ...",
    completedActions: 2,
    failedActions: 0,
  },
  data: {
    actionResults: [...],        // Raw action result objects from traceActionResult
    workingMemory: {...},
    recentActionMemories: [...],
  }
}
```

**Data Flow**:
- Reads from `state.data.actionResults` (set by multi-step loop's `traceActionResult`)
- Reads from `state.data.workingMemory` (preserved by `refreshStateAfterAction`)
- Also queries database for recent `action_result` memories (historical context)

### ACTIONS Provider

**Location**: `lib/eliza/plugin-cloud-bootstrap/providers/actions.ts`

**Purpose**: Provides available actions with their parameter schemas to the LLM.

**Position**: -1 (highest priority, runs first)

**What It Returns**:

```typescript
{
  text: `
Possible response actions: WEB_SEARCH, GENERATE_IMAGE

# Available Actions
## WEB_SEARCH
Search the web using Tavily...

## GENERATE_IMAGE
Generates an image based on a prompt...

# Action Examples
...
`,
  values: {
    actionNames: "Possible response actions: WEB_SEARCH, GENERATE_IMAGE",
    actionsWithDescriptions: "# Available Actions\n## WEB_SEARCH\n...",
    actionsWithParams: `
# Available Actions (with parameter schemas)
## WEB_SEARCH
Search the web using Tavily...

**Parameters:**
- \`query\` (required): string - The search query to look up on the web
- \`topic\` (optional): string - Search topic: 'general' or 'finance'
- \`max_results\` (optional): number - Maximum results (1-20)

---

## GENERATE_IMAGE
Generates an image based on a prompt.

**Parameters:**
- \`prompt\` (optional): string - Direct prompt for image generation
`,
    actionExamples: "# Action Examples\n...",
  },
  data: {
    actionsData: [...],  // Raw Action objects
  }
}
```

### RECENT_MESSAGES Provider

**Location**: `lib/eliza/shared/providers/recent-messages.ts`

**Purpose**: Provides conversation history with entity details.

**Position**: 94

**What It Returns**:

```typescript
{
  text: `
# Recent Messages
19:59 (just now) [user-id] UserName: can you first call web search and check the news about hyperliquid...

# Received Message
UserName: can you first call web search and check the news about hyperliquid...

# Focus your response
You are replying to the above message from **UserName**. Keep your answer relevant to that message.
`,
  values: {
    recentMessages: "# Recent Messages\n...",
    conversationLog: "# Conversation Messages\n[timestamp] User: ...",
    conversationLogWithAgentThoughts: "...",
    receivedMessageHeader: "# Received Message\n...",
    focusHeader: "# Focus your response\n...",
  },
  data: {
    messages: [...],  // Raw Memory objects
  }
}
```

### CHARACTER Provider

**Location**: `lib/eliza/shared/providers/character.ts`

**Purpose**: Provides agent personality, system prompt, and style guidelines.

**What It Returns**:

```typescript
{
  values: {
    agentName: "Eliza",
    bio: "- remembers what people care about...",
    system: "Roleplay and generate interesting dialogue on behalf of Eliza.",
    messageDirections: "**Style Guidelines:**\n- responses should feel like...",
    topics: "...",
    adjectives: "...",
  },
  text: "# About Eliza\n...",
}
```

---

## Multi-Step Execution Loop

**Location**: `CloudBootstrapMessageService.runMultiStepCore()` (lines 517-944)

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        runMultiStepCore()                           │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Initialize traceActionResult = []                                │
│    accumulatedState = composeState([RECENT_MESSAGES, ACTION_STATE,  │
│                                     ACTIONS])                       │
│    accumulatedState.data.actionResults = traceActionResult          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. WHILE iterationCount < maxIterations (default: 6)                │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ a. Refresh state with latest providers:                      │ │
│    │    accumulatedState = composeState([RECENT_MESSAGES,         │ │
│    │                        ACTION_STATE])                        │ │
│    │    accumulatedState.data.actionResults = traceActionResult   │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ b. Add iteration context:                                    │ │
│    │    stateWithIterationContext = {                             │ │
│    │      ...accumulatedState,                                    │ │
│    │      iterationCount,                                         │ │
│    │      maxIterations,                                          │ │
│    │      traceActionResult                                       │ │
│    │    }                                                         │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ c. Compose prompt with multiStepDecisionTemplate:            │ │
│    │    prompt = composePromptFromState({                         │ │
│    │      state: stateWithIterationContext,                       │ │
│    │      template: multiStepDecisionTemplate                     │ │
│    │    })                                                        │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ d. Call LLM (with retry logic, up to 5 attempts):            │ │
│    │    stepResultRaw = runtime.useModel(TEXT_LARGE, {prompt})    │ │
│    │    parsedStep = parseKeyValueXml(stepResultRaw)              │ │
│    │    → { thought, action, isFinish, parameters }               │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ e. If isFinish === true OR no action: BREAK                  │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ f. Store parameters in state:                                │ │
│    │    state.data.actionParams = actionParams                    │ │
│    │    state.data[actionKey] = {...params, source, timestamp}    │ │
│    │    (e.g., state.data.websearch = {query: "...", topic: "..."})│
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ g. Execute action via processActions:                        │ │
│    │    runtime.processActions(message, [{                        │ │
│    │      content: {                                              │ │
│    │        actions: [action],                                    │ │
│    │        actionParams: actionParams,                           │ │
│    │        actionInput: actionParams                             │ │
│    │      }                                                       │ │
│    │    }], accumulatedState, callback)                           │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ h. Read result from cache and record in traceActionResult:   │ │
│    │    const actionResults = getActionResultsFromCache(runtime)  │ │
│    │    traceActionResult.push({                                  │ │
│    │      data: { actionName: action },                           │ │
│    │      success: result?.success,                               │ │
│    │      text: result?.text,                                     │ │
│    │      values: result?.values,                                 │ │
│    │      error: success ? undefined : result?.text               │ │
│    │    })                                                        │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ i. Refresh state after action:                               │ │
│    │    accumulatedState = refreshStateAfterAction(               │ │
│    │      runtime, message, accumulatedState, traceActionResult   │ │
│    │    )                                                         │ │
│    │    // Calls composeState([RECENT_MESSAGES, ACTION_STATE])    │ │
│    │    // Preserves actionResults, workingMemory                 │ │
│    └──────────────────────────────────────────────────────────────┘ │
│                                   │                                  │
│                                   ▼                                  │
│    ┌──────────────────────────────────────────────────────────────┐ │
│    │ j. If isFinish === true: BREAK                               │ │
│    │    Otherwise: Continue to next iteration                     │ │
│    └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Generate Summary:                                                │
│    accumulatedState = composeState([RECENT_MESSAGES, ACTION_STATE]) │
│    summaryPrompt = composePromptFromState({                         │
│      state: accumulatedState,                                       │
│      template: multiStepSummaryTemplate                             │
│    })                                                               │
│    finalOutput = runtime.useModel(TEXT_LARGE, {prompt: summaryPrompt})│
│    summary = parseKeyValueXml(finalOutput)                          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Return StrategyResult:                                           │
│    {                                                                │
│      responseContent: { text: summary.text, ... },                  │
│      responseMessages: [...],                                       │
│      state: accumulatedState,                                       │
│      mode: 'simple'                                                 │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Points

1. **State Refresh After Each Action**: `refreshStateAfterAction()` re-composes state to get updated ACTION_STATE provider data after each action execution

2. **Action Results Accumulation**: `traceActionResult` array grows with each action, providing LLM with full execution history via the ACTION_STATE provider

3. **Single Action Per Iteration**: CloudBootstrap calls `processActions()` with one action at a time, reading the result immediately from cache

4. **Iteration Context**: `iterationCount`, `maxIterations`, and `traceActionResult.length` are injected directly into state for template access

5. **Parameter Flow**:
   - LLM outputs `<parameters>{"query": "Hyperliquid news"}</parameters>`
   - Parsed and stored in `state.data.actionParams`
   - Also stored in `state.data[actionKey]` (e.g., `state.data.websearch`)
   - Action handler reads from `state.data.actionParams` or `content.actionParams`

---

## Template Variable Reference

### multiStepDecisionTemplate Variables

> **Note**: The decision template intentionally excludes character personality variables (`{{system}}`, `{{bio}}`, `{{messageDirections}}`). The decision phase uses `MULTISTEP_DECISION_SYSTEM` as the system prompt instead.

| Variable | Source | Description |
|----------|--------|-------------|
| `{{recentMessages}}` | RECENT_MESSAGES provider → `state.values.recentMessages` | Conversation history |
| `{{iterationCount}}` | Direct injection | Current iteration (1-based) |
| `{{maxIterations}}` | Direct injection | Maximum iterations allowed (default: 6) |
| `{{traceActionResult.length}}` | Direct injection | Number of actions completed this round |
| `{{actionsWithParams}}` | ACTIONS provider → `state.values.actionsWithParams` | Available actions with parameter schemas |
| `{{actionResults}}` | ACTION_STATE provider → `state.values.actionResults` | Formatted previous action results |
| `{{#if traceActionResult.length}}` | Direct injection | Handlebars conditional |

### multiStepSummaryTemplate Variables

> **Note**: The summary template applies full character personality. The character's `system` prompt is used as the LLM system prompt (not in the template).

| Variable | Source | Description |
|----------|--------|-------------|
| `{{agentName}}` | CHARACTER provider | Agent's name |
| `{{bio}}` | CHARACTER provider | Agent biography |
| `{{messageDirections}}` | CHARACTER provider | Message style directions |
| `{{recentMessages}}` | RECENT_MESSAGES provider | Conversation history |
| `{{actionResults}}` | ACTION_STATE provider | Formatted action results |
| `{{hasActionResults}}` | ACTION_STATE provider | Boolean for conditional rendering |

---

## Data Flow Diagrams

### Provider → State → Template Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           PROVIDERS                                  │
├─────────────────────────────────────────────────────────────────────┤
│  ACTION_STATE      │  ACTIONS         │  RECENT_MESSAGES │ CHARACTER│
│  ┌───────────────┐ │  ┌─────────────┐ │  ┌─────────────┐ │  ┌─────┐ │
│  │ get() returns │ │  │ get()       │ │  │ get()       │ │  │ get │ │
│  │ {             │ │  │ {           │ │  │ {           │ │  │ {   │ │
│  │  text: "..."  │ │  │  text: "..." │ │  │  text: "..." │ │  │ ... │ │
│  │  values: {    │ │  │  values: {  │ │  │  values: {  │ │  │ }   │ │
│  │   actionRes.. │ │  │   actionNam.│ │  │   recentMsg.│ │  │     │ │
│  │  }            │ │  │   actionsPa.│ │  │  }          │ │  │     │ │
│  │  data: {      │ │  │  }          │ │  │  data: {    │ │  │     │ │
│  │   actionRes.. │ │  │  data: {    │ │  │   messages  │ │  │     │ │
│  │  }            │ │  │   actionsDa.│ │  │  }          │ │  │     │ │
│  │ }             │ │  │  }          │ │  │ }           │ │  │     │ │
│  └───────────────┘ │  └─────────────┘ │  └─────────────┘ │  └─────┘ │
└────────┬───────────┴────────┬────────┴────────┬─────────┴────┬─────┘
         │                    │                 │              │
         └────────────────────┴─────────────────┴──────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          composeState()                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 1. Call all provider.get() in parallel                         │ │
│  │ 2. Merge all values: state.values = { ...p1.values, ...p2... } │ │
│  │ 3. Concatenate all text: state.values.providers = p1.text + .. │ │
│  │ 4. Store raw results: state.data.providers[name] = result      │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                              STATE                                  │
│  {                                                                  │
│    values: {                                                        │
│      providers: "# Previous Action Results\n...\n# Available...",   │
│      actionResults: "**1. WEB_SEARCH** - Success\n...",             │
│      actionsWithParams: "## WEB_SEARCH\n**Parameters:**\n...",      │
│      recentMessages: "# Recent Messages\n...",                      │
│      agentName: "Eliza",                                            │
│      system: "Roleplay and generate interesting dialogue...",       │
│    },                                                               │
│    data: {                                                          │
│      providers: { ACTION_STATE: {...}, ACTIONS: {...}, ... },       │
│      actionResults: [{...}, {...}],  // From traceActionResult      │
│      workingMemory: {...}                                           │
│    },                                                               │
│    text: "# Previous Action Results\n..."                           │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      composePromptFromState()                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ templateData = { ...state.values, iterationCount, ... }        │ │
│  │ Handlebars.compile(template)(templateData)                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         FINAL PROMPT                                │
│  <task>Determine the next step...</task>                            │
│  {{system}} → "Roleplay and generate interesting dialogue..."       │
│  {{recentMessages}} → "User: Search for Hyperliquid news..."        │
│  {{iterationCount}} → "2"                                           │
│  {{traceActionResult.length}} → "1"                                 │
│  {{actionResults}} → "**1. WEB_SEARCH** - Success..."               │
│  {{actionsWithParams}} → "## WEB_SEARCH\n**Parameters:**..."        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Action Parameter Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     LLM Decision Output                             │
│  <response>                                                         │
│    <thought>Step 1/6. Actions taken: 0. User wants news about       │
│              Hyperliquid. I'll search with finance topic.</thought> │
│    <action>WEB_SEARCH</action>                                      │
│    <parameters>{"query":"Hyperliquid news","topic":"finance",       │
│                 "max_results":5}</parameters>                       │
│    <isFinish>false</isFinish>                                       │
│  </response>                                                        │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      parseKeyValueXml()                             │
│  {                                                                  │
│    thought: "Step 1/6. Actions taken: 0. User wants...",            │
│    action: "WEB_SEARCH",                                            │
│    parameters: '{"query":"Hyperliquid news","topic":"finance",...}',│
│    isFinish: "false"                                                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    CloudBootstrapMessageService                     │
│  actionParams = JSON.parse(parameters)                              │
│  // { query: "Hyperliquid news", topic: "finance", max_results: 5 } │
│                                                                     │
│  // Store in state for action handler access:                       │
│  state.data.actionParams = actionParams                             │
│  state.data.websearch = { ...actionParams, _source, _timestamp }    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     runtime.processActions()                        │
│  Receives: responseMemory.content = {                               │
│    actions: ["WEB_SEARCH"],                                         │
│    actionParams: { query: "Hyperliquid news", topic: "finance" },   │
│    actionInput: { query: "Hyperliquid news", topic: "finance" }     │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Action Handler                               │
│  // webSearch.ts - extractSearchParams()                            │
│                                                                     │
│  // Priority order for parameter access:                            │
│  const stateParams = composedState?.data?.actionParams              │
│                      || composedState?.data?.webSearch              │
│                      || composedState?.data?.websearch              │
│                      || {};                                         │
│                                                                     │
│  // If params found in state, use them directly:                    │
│  if (stateParams?.query?.trim()) {                                  │
│    return stateParams; // No LLM extraction needed                  │
│  }                                                                  │
│                                                                     │
│  // Otherwise, extract from conversation via LLM (fallback)         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Action Result                                │
│  {                                                                  │
│    text: "Based on the search results, Hyperliquid's HYPE...",      │
│    success: true,                                                   │
│    data: {                                                          │
│      actionName: "WEB_SEARCH",                                      │
│      searchMetadata: { query: "...", resultsFound: 5, ... }         │
│    },                                                               │
│    values: { ... }                                                  │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 traceActionResult[] (updated)                       │
│  [                                                                  │
│    {                                                                │
│      data: { actionName: "WEB_SEARCH" },                            │
│      success: true,                                                 │
│      text: "Based on the search results, Hyperliquid's HYPE...",    │
│      values: { query: "Hyperliquid news", resultsFound: 5 }         │
│    }                                                                │
│  ]                                                                  │
│                                                                     │
│  → This is passed to refreshStateAfterAction()                      │
│  → ACTION_STATE provider reads it on next iteration                 │
│  → LLM sees formatted results in {{actionResults}}                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Complete Request Lifecycle

### 1. HTTP Request → SSE Stream

```
Browser                           Server
   │                                │
   │  POST /api/eliza/rooms/{roomId}/messages/stream
   │  {text: "search hyperliquid news", ...}
   │  ─────────────────────────────►│
   │                                │ route.ts: authenticate
   │                                │ route.ts: buildUserContext
   │                                │ RuntimeFactory: get/create runtime
   │                                │ MessageHandler: create handler
   │                                │
   │  SSE: event: connected         │
   │  ◄─────────────────────────────│
   │                                │
   │  SSE: event: message (user)    │
   │  ◄─────────────────────────────│
   │                                │
   │  SSE: event: message (thinking)│
   │  ◄─────────────────────────────│
   │                                │
   │                                │ CloudBootstrapMessageService
   │                                │   → shouldRespond check
   │                                │   → runMultiStepCore()
   │                                │
   │  SSE: event: reasoning (planning)
   │  ◄─────────────────────────────│ (LLM thought streamed)
   │                                │
   │  SSE: event: reasoning (actions)
   │  ◄─────────────────────────────│ ("Executing WEB_SEARCH...")
   │                                │
   │                                │ (action executes: Tavily API)
   │                                │
   │  SSE: event: reasoning (actions)
   │  ◄─────────────────────────────│ ("Action succeeded: ...")
   │                                │
   │                                │ (iteration 2 begins...)
   │                                │ (repeat for more actions)
   │                                │
   │  SSE: event: reasoning (response)
   │  ◄─────────────────────────────│ ("Generating final response")
   │                                │
   │  SSE: event: chunk             │
   │  ◄─────────────────────────────│ (final text streamed)
   │                                │
   │  SSE: event: message (agent)   │
   │  ◄─────────────────────────────│ (complete response)
   │                                │
   │  SSE: event: done              │
   │  ◄─────────────────────────────│
   │                                │
```

### 2. LLM Call Sequence

For a typical 2-action request (e.g., "search Hyperliquid then PumpFun"):

```
┌────────────────────────────────────────────────────────────────────┐
│                        LLM CALL #1: multiStepDecision              │
│  Iteration 1/6, Actions taken: 0                                   │
│                                                                    │
│  Input: User message + empty actionResults                         │
│  Output: <action>WEB_SEARCH</action>                               │
│          <parameters>{"query":"Hyperliquid news"}</parameters>     │
│          <isFinish>false</isFinish>                                │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        ACTION: WEB_SEARCH                          │
│  Tavily API call with query="Hyperliquid news", topic="finance"    │
│  Result: Success, 5 results about HYPE token surge                 │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        LLM CALL #2: multiStepDecision              │
│  Iteration 2/6, Actions taken: 1                                   │
│                                                                    │
│  Input: actionResults shows WEB_SEARCH #1 success                  │
│  Output: <action>WEB_SEARCH</action>                               │
│          <parameters>{"query":"PumpFun token news"}</parameters>   │
│          <isFinish>false</isFinish>                                │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        ACTION: WEB_SEARCH                          │
│  Tavily API call with query="PumpFun token news", topic="finance"  │
│  Result: Success, 5 results about PUMP token rally                 │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        LLM CALL #3: multiStepDecision              │
│  Iteration 3/6, Actions taken: 2                                   │
│                                                                    │
│  Input: actionResults shows both WEB_SEARCH successes              │
│  Output: <action></action>                                         │
│          <isFinish>true</isFinish>                                 │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                        LLM CALL #4: multiStepSummary               │
│  Generate final user-facing response                               │
│                                                                    │
│  Input: Both search results in actionResults                       │
│  Output: <text>here's what's happening with both:                  │
│          **hyperliquid (HYPE):** up 25%...                         │
│          **pump.fun (PUMP):** up 25%...</text>                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Summary

The CloudBootstrapMessageService implements a sophisticated multi-step execution loop that:

1. **Composes state** from multiple providers (ACTION_STATE, ACTIONS, RECENT_MESSAGES, CHARACTER)
2. **Builds prompts** using Handlebars templates with state values
3. **Iteratively executes actions** based on LLM decisions (one at a time)
4. **Extracts parameters** from XML output and stores them in state for action handlers
5. **Refreshes state** after each action for up-to-date context via ACTION_STATE provider
6. **Generates a summary** using accumulated action results

### Key Differences from Default ElizaOS MessageService

| Feature | Default MessageService | CloudBootstrapMessageService |
|---------|----------------------|------------------------------|
| Action execution | Can execute multiple actions in one call | One action per iteration |
| Parameter passing | From message content | Extracted from XML, stored in state.data.actionParams |
| Result tracking | Framework's actionPlan | Custom traceActionResult[] array |
| State refresh | Not between actions | After each action via refreshStateAfterAction() |
| Summary generation | Not built-in | Dedicated multiStepSummaryTemplate |
| Streaming | Basic | Real-time reasoning/thinking phases |

Understanding this flow is essential for:
- Adding new providers that contribute to state
- Modifying templates to use new state values
- Creating actions that read parameters from state.data.actionParams
- Debugging why certain information isn't reaching the LLM
- Optimizing context size and execution performance
