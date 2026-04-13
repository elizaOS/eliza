# elizaOS Core Abstractions

## Runtime

The main TypeScript runtime is `AgentRuntime`.

It owns:

- registered plugins
- actions, providers, evaluators, services, routes, and model handlers
- database adapter access
- message processing
- cached per-message state

`runtime.initialize()` registers plugins, initializes the adapter, creates the default message service, and can run plugin migrations.

## Persistent Versus Ephemeral Data

### `Memory`

Persistent data. Messages, documents, fragments, and other stored knowledge live here.

Typical fields:

- `content`
- `embedding`
- `metadata`

### `State`

Ephemeral per-turn context used for prompt composition and action execution.

Typical parts:

- `values`
- `data`
- `text`

Providers build `State`; memories persist across turns.

## Core Conversation Model

- **Entity**: participant identity
- **Room**: conversation space
- **World**: container for related rooms

Typical flow:

1. ensure the connection (`world`, `room`, `entity`)
2. create a message memory
3. call the message service

## Provider Model

Providers build context before inference.

They can contribute:

- `text` for human-readable prompt context
- `values` for template variables
- `data` for structured cached state

Providers are ordered by `position`. `private` and `dynamic` providers are excluded from the default provider set unless explicitly requested.

## Action Model

Actions are elizaOS tools.

The default flow is:

1. model emits an action plan
2. runtime executes actions
3. action results can feed follow-up state or callbacks

Single-action and multi-action modes both exist.

## Evaluators

Evaluators run after response generation and action execution.

Use them for:

- reflection
- extraction
- safety checks
- policy enforcement

## End-To-End Flow

The default TypeScript pipeline is:

1. ingest message
2. persist incoming memory
3. compose state via providers
4. optionally process attachments
5. decide whether to respond
6. run model inference
7. execute actions
8. persist/send the response
9. run evaluators
10. emit lifecycle events
