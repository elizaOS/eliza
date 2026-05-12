# elizaOS Plugin Development

## Plugin Shape

An elizaOS plugin is a plain object that can register:

- `actions`
- `providers`
- `services`
- `models`
- `evaluators`
- `routes`
- `events`
- optionally an adapter or schema

## Key Extension Points

### Actions

Use for tool execution or side effects.

- declared in `plugin.actions`
- executed by planned tool calls
- can declare structured parameters

### Providers

Use for state and prompt context.

- declared in `plugin.providers`
- executed during `runtime.composeState(...)`
- return `text`, `values`, and/or `data`

### Services

Use for long-lived shared logic such as API clients, caches, or background connections.

### Models

Use to register inference handlers for text, embeddings, image description, and related model types.

### Evaluators

Use for post-response analysis or policy checks.

### Routes

Use for plugin-owned HTTP endpoints. Routes are namespaced under the plugin name.

## Practical Guidance

- If the feature changes prompt context, it is usually a provider.
- If the feature performs an operation, it is usually an action.
- If the feature needs shared lifecycle-managed resources, it is usually a service.
- If the feature changes inference backends, it is usually a model handler.

## Runtime Registration Order

At plugin registration:

1. `plugin.init(...)` runs first
2. components are registered
3. routes are namespaced
4. services are initialized asynchronously

## Milady Context

In this repo, Milady adds product behavior around elizaOS, but the underlying runtime composition rules still come from elizaOS. When a Milady feature behaves strangely, check whether the root cause is actually in:

- provider ordering
- action planning
- model handler selection
- plugin auto-enable or plugin loading
- database adapter initialization
