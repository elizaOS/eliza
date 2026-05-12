---
title: "Schémas de Plugins"
sidebarTitle: "Schémas"
description: "Référence complète des schémas pour les manifestes de plugins, actions, fournisseurs, évaluateurs, services, routes et gestionnaires de modèles."
---

Cette page documente les interfaces TypeScript et les schémas JSON pour chaque primitive de plugin dans Eliza/elizaOS.

<div id="plugin-interface">

## Plugin Interface

</div>

L'exportation de niveau supérieur d'un package de plugin.

```typescript
interface Plugin {
  /** Unique plugin name (kebab-case recommended) */
  name: string;

  /** Human-readable description shown in the admin panel */
  description: string;

  /** Called once when the plugin is loaded by the runtime */
  init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void>;

  /** Static configuration defaults */
  config?: Record<string, unknown>;

  /** Things the agent can do */
  actions?: Action[];

  /** Context injected into the agent prompt */
  providers?: Provider[];

  /** Post-response assessment logic */
  evaluators?: Evaluator[];

  /** Long-running background processes */
  services?: ServiceClass[];

  /** HTTP endpoints exposed by the API server */
  routes?: Route[];

  /** Runtime event callbacks */
  events?: Record<string, EventHandler[]>;

  /** Custom model inference handlers */
  models?: Record<string, ModelHandler>;

  /** Custom entity component type definitions */
  componentTypes?: ComponentType[];

  /** Load order relative to other plugins (higher = loaded later) */
  priority?: number;

  /** Plugin names this plugin depends on (ensures ordering) */
  dependencies?: string[];

  /** Test suites included with the plugin */
  tests?: TestSuite[];
}
```

<div id="action-schema">

## Action Schema

</div>

```typescript
interface Action {
  /** Unique name in SCREAMING_SNAKE_CASE */
  name: string;

  /** Shown to the LLM — determines when the action is selected */
  description: string;

  /** Alternative names the LLM may use to invoke this action */
  similes?: string[];

  /**
   * Return true when this action can run in the current context.
   * Called before every potential invocation.
   */
  validate: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ) => Promise<boolean>;

  /**
   * Perform the action. Return an ActionResult or undefined.
   * Do not throw — return success: false with an error message instead.
   */
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ) => Promise<ActionResult | undefined>;

  /** Structured parameters the LLM extracts from the conversation */
  parameters?: ActionParameter[];

  /** Example conversations demonstrating usage (guides LLM selection) */
  examples?: ActionExample[][];

  /** Evaluation priority — higher values are checked first */
  priority?: number;

  /** Optional categorization tags */
  tags?: string[];
}

interface ActionParameter {
  name: string;
  description: string;
  required: boolean;
  schema: JsonSchema;
}

interface ActionResult {
  success: boolean;
  text?: string;
  values?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: string | Error;
  continueChain?: boolean;
  cleanup?: () => void | Promise<void>;
}
```

<div id="provider-schema">

## Provider Schema

</div>

```typescript
interface Provider {
  /** Provider name — used for logging and deduplication */
  name: string;

  /** Description of what context this provider supplies */
  description?: string;

  /**
   * Ordering hint. Negative values run before core providers.
   * Positive values run after. Default: 0.
   */
  position?: number;

  /**
   * If true, this provider is NOT included automatically.
   * Must be referenced explicitly in prompts.
   */
  private?: boolean;

  /** Returns context to inject into the agent prompt */
  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ) => Promise<ProviderResult>;
}

interface ProviderResult {
  /** Text block injected into the prompt */
  text?: string;

  /** Key-value pairs for template substitution */
  values?: Record<string, unknown>;

  /** Structured data for programmatic access */
  data?: Record<string, unknown>;
}
```

<div id="evaluator-schema">

## Evaluator Schema

</div>

```typescript
interface Evaluator {
  /** Evaluator name */
  name: string;

  /** Description of what this evaluator checks */
  description: string;

  /**
   * If true, runs after every response.
   * If false (default), runs probabilistically based on examples.
   */
  alwaysRun?: boolean;

  /** Alternative descriptions */
  similes?: string[];

  /** Example input/output pairs for LLM guidance */
  examples: EvaluationExample[];

  /** Return true if this evaluator applies to the current context */
  validate: Validator;

  /** Perform the evaluation — can trigger side effects or follow-ups */
  handler: Handler;
}

interface EvaluationExample {
  messages: Array<{
    user: string;
    content: { text: string };
  }>;
}
```

<div id="service-schema">

## Service Schema

</div>

```typescript
interface ServiceDefinition {
  /** Unique service type identifier (used by runtime.getService()) */
  serviceType: string;

  /** Human-readable description */
  description?: string;

  /**
   * Called when the runtime starts.
   * Must return a Service instance with a stop() method.
   */
  start: (runtime: IAgentRuntime) => Promise<Service>;

  /** Optional global cleanup called when the runtime stops */
  stop?: () => Promise<void>;
}

interface Service {
  stop: () => Promise<void>;
  [key: string]: unknown; // Additional public service methods
}
```

<div id="route-schema">

## Route Schema

</div>

```typescript
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Route {
  type: HttpMethod | "STATIC";
  path: string;

  /** Route handler — omit only for STATIC routes */
  handler?: (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => Promise<void>;

  /** If true, accessible without authentication */
  public?: boolean;

  /** Required when public: true */
  name?: string;

  /** Set to true to accept multipart/form-data uploads */
  isMultipart?: boolean;

  /** Directory path to serve (STATIC routes only) */
  filePath?: string;
}
```

<div id="model-handler-schema">

## Model Handler Schema

</div>

```typescript
type ModelHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams | ImageGenerationParams | EmbeddingParams | unknown,
) => Promise<ModelResult>;

// Available model type keys:
const MODEL_TYPES = [
  "TEXT_SMALL",           // Fast text generation
  "TEXT_LARGE",           // Large context text generation
  "TEXT_COMPLETION",      // Completion-style generation
  "TEXT_EMBEDDING",       // Embedding vectors
  "TEXT_TOKENIZER_ENCODE",
  "TEXT_TOKENIZER_DECODE",
  "IMAGE",                // Image generation
  "IMAGE_DESCRIPTION",    // Vision / image analysis
  "TRANSCRIPTION",        // Speech-to-text
  "TEXT_TO_SPEECH",       // TTS
  "AUDIO",                // Audio processing
  "VIDEO",                // Video processing
  "RESEARCH",             // Research/search-augmented generation
] as const;
```

<div id="plugin-manifest-elizaosplugin-json">

## Plugin Manifest (elizaos.plugin.json)

</div>

Manifeste JSON optionnel pour une intégration enrichie de l'interface utilisateur et les métadonnées du marketplace.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "A plugin that does useful things",
  "version": "1.0.0",
  "kind": "skill",

  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "timeout": { "type": "number", "default": 30000 }
    },
    "required": ["apiKey"]
  },

  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true,
      "help": "Get your API key from the dashboard"
    },
    "timeout": {
      "label": "Request Timeout (ms)",
      "type": "number",
      "advanced": true
    }
  },

  "requiredSecrets": ["MY_PLUGIN_API_KEY"],
  "optionalSecrets": ["MY_PLUGIN_DEBUG"],
  "dependencies": ["other-plugin"],

  "channels": [],
  "providers": ["myContext"],
  "skills": [],
  "gatewayMethods": [],
  "cliCommands": []
}
```

<div id="kind-values">

### Valeurs de kind

</div>

| Valeur | Description |
|--------|-------------|
| `memory` | Adaptateurs de mémoire ou de stockage |
| `channel` | Connecteurs de plateformes de messagerie |
| `provider` | Fournisseurs de contexte ou de données |
| `skill` | Extensions de fonctionnalités basées sur les compétences |
| `database` | Adaptateurs de base de données |

<div id="component-type-schema">

## Component Type Schema

</div>

Utilisé pour définir des données structurées personnalisées attachées aux enregistrements d'entités.

```typescript
interface ComponentType {
  /** Component type identifier */
  name: string;

  /** JSON Schema for the component's data shape */
  schema: JsonSchema;

  /** Optional runtime validation function */
  validator?: (data: unknown) => boolean;
}
```

<div id="related">

## Associé

</div>

- [Créer un Plugin](/fr/plugins/create-a-plugin) — Construire un plugin à partir de zéro
- [Modèles de Plugins](/fr/plugins/patterns) — Modèles d'implémentation courants
- [Architecture des Plugins](/fr/plugins/architecture) — Conception du système et cycle de vie
