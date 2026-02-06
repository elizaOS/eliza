# API Reference (Core)

This is a **source-oriented** reference for the TypeScript runtime and its core extension points.

## Runtime

### `AgentRuntime`

- **File**: `packages/typescript/src/runtime.ts`
- **Implements**: `IAgentRuntime` (`packages/typescript/src/types/runtime.ts`)

Key methods:

- **Initialization**
  - `constructor(opts?: { character?: Character; plugins?: Plugin[]; adapter?: IDatabaseAdapter; ... })`
  - `initialize(options?: { skipMigrations?: boolean }): Promise<void>`
  - `stop(): Promise<void>`
- **Plugins**
  - `registerPlugin(plugin: Plugin): Promise<void>`
- **State**
  - `composeState(message: Memory, includeList?: string[] | null, onlyInclude?: boolean, skipCache?: boolean): Promise<State>`
- **Models**
  - `useModel(modelType: TextGenerationModelType, params: GenerateTextParams, provider?: string): Promise<string>`
  - `useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(modelType: T, params: ModelParamsMap[T], provider?: string): Promise<R>`
  - `registerModel(modelType: ModelTypeName | string, handler, provider: string, priority?: number): void`
  - `getModel(modelType: ModelTypeName | string): ((runtime, params) => Promise<unknown>) | undefined`
- **Actions & evaluation**
  - `processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback, options?: { onStreamChunk?: (chunk: string, messageId?: string) => Promise<void> }): Promise<void>`
  - `evaluate(message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback, responses?: Memory[]): Promise<Evaluator[] | null>`
- **Registries**
  - `registerAction(action: Action): void`
  - `registerProvider(provider: Provider): void`
  - `registerEvaluator(evaluator: Evaluator): void`
  - `registerService(service: typeof Service): Promise<void>`
  - `getService<T extends Service>(serviceName: ServiceTypeName | string): T | null`
- **Persistence helpers**
  - See `IAgentRuntime extends IDatabaseAdapter` in `packages/typescript/src/types/runtime.ts`

## Plugins

### `Plugin`

- **File**: `packages/typescript/src/types/plugin.ts`

```ts
export interface Plugin {
  name: string;
  description: string;
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;
  config?: Record<string, string | number | boolean | null>;
  services?: (typeof Service)[];
  componentTypes?: ComponentTypeDefinition[];
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: { [K in keyof ModelParamsMap]?: (runtime: IAgentRuntime, params: ModelParamsMap[K]) => Promise<PluginModelResult<K>> };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  dependencies?: string[];
  testDependencies?: string[];
  priority?: number;
  schema?: Record<string, unknown>;
}
```

## Actions / Providers / Evaluators

- **File**: `packages/typescript/src/types/components.ts`

### `Action`

```ts
export interface Action {
  name: string;
  description: string;
  handler: Handler;
  validate: Validator;
  similes?: string[];
  examples?: ActionExample[][];
  priority?: number;
  tags?: string[];
  parameters?: ActionParameter[];
}
```

### `Provider`

```ts
export interface Provider {
  name: string;
  description?: string;
  dynamic?: boolean;
  position?: number;
  private?: boolean;
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
```

### `Evaluator`

```ts
export interface Evaluator {
  alwaysRun?: boolean;
  description: string;
  similes?: string[];
  examples: EvaluationExample[];
  handler: Handler;
  name: string;
  validate: Validator;
}
```

## State

- **File**: `packages/typescript/src/types/state.ts`

```ts
export interface State {
  values: StateValues;
  data: StateData;
  text: string;
  [key: string]: unknown;
}
```

## Memory

- **File**: `packages/typescript/src/types/memory.ts`

```ts
export interface Memory {
  id?: UUID;
  entityId: UUID;
  agentId?: UUID;
  createdAt?: number;
  content: Content;
  embedding?: number[];
  roomId: UUID;
  worldId?: UUID;
  unique?: boolean;
  similarity?: number;
  metadata?: MemoryMetadata;
}
```

Helper:

- `createMessageMemory(...)`: `packages/typescript/src/memory.ts`

## Database

### `DatabaseAdapter`

- **File**: `packages/typescript/src/database.ts`

`DatabaseAdapter` is an abstract base class implementing `IDatabaseAdapter`. Concrete adapters (e.g. SQL/PGLite/Postgres) live in plugins such as `@elizaos/plugin-sql`.

## Interop APIs

See `packages/interop/README.md` and `INTEROP_GUIDE.md` for the cross-language plugin contract and loaders.

