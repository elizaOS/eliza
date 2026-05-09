---
title: "Développement de Plugins"
sidebarTitle: "Développement de Plugins"
description: "Créez, testez et publiez des plugins pour Eliza/elizaOS."
---

Ce guide vous accompagne dans la création, le test et la publication de plugins pour Eliza/elizaOS.

<div id="table-of-contents">

## Table des Matières

</div>

1. [Vue d'Ensemble de l'Architecture des Plugins](#plugin-architecture-overview)
2. [Créer Votre Premier Plugin](#creating-your-first-plugin)
3. [Actions](#actions)
4. [Providers](#providers)
5. [Services](#services)
6. [Routes](#routes)
7. [Gestionnaires d'Événements](#event-handlers)
8. [Test des Plugins](#testing-plugins)
9. [Publication des Plugins](#publishing-plugins)

---

<div id="plugin-architecture-overview">

## Vue d'Ensemble de l'Architecture des Plugins

</div>

Un plugin est une extension modulaire qui ajoute des capacités à un agent elizaOS. Les plugins peuvent fournir :

- **Actions** — Ce que l'agent peut faire (envoyer des messages, générer des images, redémarrer)
- **Providers** — Contexte injecté dans les prompts de l'agent (fichiers du workspace, état de session)
- **Services** — Processus en arrière-plan de longue durée (serveurs WebSocket, boucles de sondage)
- **Routes** — Endpoints HTTP exposés par l'API de l'agent
- **Gestionnaires d'Événements** — Callbacks pour les événements du runtime (message reçu, envoyé, etc.)
- **Evaluators** — Logique d'évaluation des réponses de l'agent
- **Models** — Gestionnaires de modèles personnalisés pour des types d'inférence spécifiques

<div id="the-plugin-interface">

### L'Interface du Plugin

</div>

```typescript
import type { Plugin } from "@elizaos/core";

const myPlugin: Plugin = {
  // Required
  name: "my-plugin",
  description: "A brief description of what this plugin does",

  // Optional — called once when the plugin is loaded
  init: async (config, runtime) => {
    // Initialize connections, register workers, etc.
  },

  // Optional — static configuration values
  config: {
    defaultTimeout: 30000,
    maxRetries: 3,
  },

  // Optional — capabilities
  actions: [],      // Action[]
  providers: [],    // Provider[]
  services: [],     // ServiceClass[]
  routes: [],       // Route[]
  events: {},       // { EVENT_NAME: handler[] }
  evaluators: [],   // Evaluator[]

  // Optional — custom model handlers
  models: {
    // TEXT_SMALL: async (runtime, params) => { ... }
  },

  // Optional — plugin load order (higher = loaded later)
  priority: 0,

  // Optional — other plugins this one depends on
  dependencies: ["other-plugin"],

  // Optional — test suites
  tests: [],
};

export default myPlugin;
```

<div id="plugin-lifecycle">

### Cycle de Vie du Plugin

</div>

1. **Découverte** — Les plugins sont découverts depuis :
   - Plugins intégrés (livrés avec Eliza)
   - Plugins du workspace (`./plugins/`)
   - Plugins globaux (`~/.eliza/plugins/`)
   - Paquets npm (`@elizaos/plugin-*`)
   - Plugins spécifiés dans la configuration

2. **Chargement** — Les modules des plugins sont importés et validés

3. **Résolution des Dépendances** — Les plugins sont triés par dépendances et priorité

4. **Initialisation** — `plugin.init(config, runtime)` est appelé pour chaque plugin

5. **Enregistrement** — Les actions, providers, services, routes et événements sont enregistrés auprès du runtime

---

<div id="creating-your-first-plugin">

## Créer Votre Premier Plugin

</div>

<div id="minimal-plugin-structure">

### Structure Minimale du Plugin

</div>

```
my-plugin/
├── package.json
├── src/
│   └── index.ts
└── tsconfig.json
```

<div id="packagejson">

### package.json

</div>

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@elizaos/core": "alpha"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

<div id="srcindexts">

### src/index.ts

</div>

```typescript
import type { Plugin, Action, Provider } from "@elizaos/core";

// A simple action
const greetAction: Action = {
  name: "GREET",
  description: "Greet someone by name",
  similes: ["SAY_HELLO", "WELCOME"],

  validate: async (runtime, message, state) => {
    // Return true if this action can run
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    const params = options?.parameters;
    const name = typeof params?.name === "string" ? params.name : "friend";

    return {
      success: true,
      text: `Hello, ${name}! Nice to meet you.`,
    };
  },

  parameters: [
    {
      name: "name",
      description: "The name of the person to greet",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      { user: "user", content: { text: "Say hi to Alice" } },
      { user: "assistant", content: { text: "Hello, Alice! Nice to meet you.", action: "GREET" } },
    ],
  ],
};

// A simple provider
const statusProvider: Provider = {
  name: "pluginStatus",
  description: "Provides plugin status information",

  get: async (runtime, message, state) => {
    return {
      text: "My Plugin is active and running.",
      values: {
        pluginActive: true,
        version: "1.0.0",
      },
    };
  },
};

// The plugin export
const myPlugin: Plugin = {
  name: "my-plugin",
  description: "A sample plugin demonstrating the basics",

  actions: [greetAction],
  providers: [statusProvider],

  init: async (config, runtime) => {
    runtime.logger?.info("[my-plugin] Initialized!");
  },
};

export default myPlugin;
```

---

<div id="actions">

## Actions

</div>

Les actions sont ce que l'agent peut faire. Le LLM choisit d'invoquer une action en fonction du contexte de la conversation et de la description/des exemples de l'action.

<div id="action-interface">

### Interface de l'Action

</div>

```typescript
interface Action {
  /** Unique action name (uppercase with underscores by convention) */
  name: string;

  /** Human-readable description — shown to the LLM */
  description: string;

  /** Alternative names the LLM might use */
  similes?: string[];

  /** Validation — return true if the action can run */
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;

  /** Execution handler — performs the action */
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) => Promise<ActionResult | undefined>;

  /** Input parameters extracted from conversation */
  parameters?: ActionParameter[];

  /** Example conversations showing usage */
  examples?: ActionExample[][];

  /** Optional priority (higher = evaluated first) */
  priority?: number;

  /** Optional tags for categorization */
  tags?: string[];
}
```

<div id="action-parameters">

### Paramètres de l'Action

</div>

Les paramètres permettent au LLM d'extraire des données structurées de la conversation :

```typescript
const sendMessageAction: Action = {
  name: "MESSAGE",
  description: "Send a message to a specific user on a platform",

  parameters: [
    {
      name: "targetUser",
      description: "Username or ID of the recipient",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "message",
      description: "The message content to send",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "platform",
      description: "Platform to send on (telegram, discord, etc.)",
      required: false,
      schema: {
        type: "string",
        enum: ["telegram", "discord", "slack"],
        default: "telegram",
      },
    },
  ],

  validate: async () => true,

  handler: async (runtime, message, state, options) => {
    const params = options?.parameters;

    if (!params?.targetUser || !params?.message) {
      return {
        success: false,
        error: "Missing required parameters: targetUser and message",
      };
    }

    const targetUser = params.targetUser as string;
    const messageText = params.message as string;
    const platform = (params.platform as string) ?? "telegram";

    // Actually send the message...
    await runtime.sendMessage(targetUser, messageText, platform);

    return {
      success: true,
      text: `Message sent to ${targetUser} on ${platform}`,
      data: { targetUser, platform },
    };
  },
};
```

<div id="action-result">

### Résultat de l'Action

</div>

Les actions retournent un objet `ActionResult` :

```typescript
interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;

  /** Human-readable result text */
  text?: string;

  /** Values to merge into state */
  values?: Record<string, unknown>;

  /** Structured data for programmatic access */
  data?: Record<string, unknown>;

  /** Error information if failed */
  error?: string | Error;

  /** For chained actions — continue to next? */
  continueChain?: boolean;

  /** Cleanup function after completion */
  cleanup?: () => void | Promise<void>;
}
```

---

<div id="providers">

## Providers

</div>

Les providers injectent du contexte dans le prompt de l'agent. Ils sont appelés avant chaque inférence du LLM pour fournir des informations pertinentes.

<div id="provider-interface">

### Interface du Provider

</div>

```typescript
interface Provider {
  /** Provider name */
  name: string;

  /** Description of what this provider supplies */
  description?: string;

  /** Position in provider list (negative = earlier, positive = later) */
  position?: number;

  /** If true, must be called explicitly (not auto-included) */
  private?: boolean;

  /** Data retrieval function */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
```

<div id="provider-result">

### Résultat du Provider

</div>

```typescript
interface ProviderResult {
  /** Human-readable text injected into the prompt */
  text?: string;

  /** Key-value pairs for template substitution */
  values?: Record<string, unknown>;

  /** Structured data for other components */
  data?: Record<string, unknown>;
}
```

<div id="provider-example">

### Exemple de Provider

</div>

```typescript
const workspaceProvider: Provider = {
  name: "workspace",
  description: "Provides workspace file contents",
  position: -10, // Run early

  get: async (runtime, message, state) => {
    const workspaceDir = runtime.getSetting("WORKSPACE_DIR") || "~/.eliza/workspace";

    // Read key files from workspace
    const agentsMd = await readFile(path.join(workspaceDir, "AGENTS.md"));
    const toolsMd = await readFile(path.join(workspaceDir, "TOOLS.md"));

    const files = [];
    if (agentsMd) files.push(`## AGENTS.md\n${agentsMd}`);
    if (toolsMd) files.push(`## TOOLS.md\n${toolsMd}`);

    return {
      text: files.length > 0
        ? `# Workspace Files\n\n${files.join("\n\n")}`
        : "",
      values: {
        workspaceDir,
        hasAgentsMd: !!agentsMd,
        hasToolsMd: !!toolsMd,
      },
    };
  },
};
```

---

<div id="services">

## Services

</div>

Les services sont des processus en arrière-plan de longue durée. Ils démarrent lorsque le runtime s'initialise et s'arrêtent lorsqu'il se ferme.

<div id="creating-a-service">

### Créer un Service

</div>

```typescript
import { Service, ServiceBuilder, type IAgentRuntime } from "@elizaos/core";

// Option 1: Using ServiceBuilder (recommended)
const MyPollingService = new ServiceBuilder("my_polling")
  .withDescription("Polls an external API periodically")
  .withStart(async (runtime: IAgentRuntime) => {
    const intervalMs = 60_000; // 1 minute
    let intervalId: NodeJS.Timeout;

    const poll = async () => {
      try {
        const data = await fetchExternalApi();
        runtime.logger?.info("[my_polling] Polled data:", data);
      } catch (err) {
        runtime.logger?.error("[my_polling] Poll failed:", err);
      }
    };

    // Start polling
    intervalId = setInterval(poll, intervalMs);
    await poll(); // Initial poll

    // Return service instance with stop capability
    return {
      stop: async () => {
        clearInterval(intervalId);
        runtime.logger?.info("[my_polling] Stopped");
      },
    } as Service;
  })
  .build();

// Option 2: Using defineService
import { defineService } from "@elizaos/core";

const MyService = defineService({
  serviceType: "my_service",
  description: "My custom service",

  start: async (runtime) => {
    // Initialize...
    return {
      // Service methods
      doSomething: () => { /* ... */ },
      stop: async () => { /* cleanup */ },
    };
  },

  stop: async () => {
    // Global cleanup if needed
  },
});
```

<div id="using-services-in-a-plugin">

### Utiliser les Services dans un Plugin

</div>

```typescript
const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Plugin with a background service",

  services: [MyPollingService],

  actions: [
    {
      name: "CHECK_SERVICE",
      description: "Check if the polling service is running",
      validate: async () => true,
      handler: async (runtime) => {
        const service = runtime.getService("my_polling");
        return {
          success: true,
          text: service ? "Polling service is active" : "Service not found",
        };
      },
    },
  ],
};
```

---

<div id="routes">

## Routes

</div>

Les routes exposent des endpoints HTTP via le serveur API de l'agent.

<div id="route-types">

### Types de Route

</div>

```typescript
type Route = {
  type: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
  path: string;
  handler?: (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => Promise<void>;

  // For public routes (accessible without auth)
  public?: boolean;
  name?: string; // Required if public: true

  // For file uploads
  isMultipart?: boolean;

  // For static file serving
  filePath?: string; // Only for type: "STATIC"
};
```

<div id="route-example">

### Exemple de Route

</div>

```typescript
const myPlugin: Plugin = {
  name: "api-plugin",
  description: "Adds custom API endpoints",

  routes: [
    // Public GET endpoint
    {
      type: "GET",
      path: "/api/my-plugin/status",
      public: true,
      name: "my-plugin-status",
      handler: async (req, res, runtime) => {
        res.status(200).json({
          status: "ok",
          agentId: runtime.agentId,
          timestamp: Date.now(),
        });
      },
    },

    // Protected POST endpoint
    {
      type: "POST",
      path: "/api/my-plugin/action",
      handler: async (req, res, runtime) => {
        const { action, data } = req.body ?? {};

        if (!action) {
          res.status(400).json({ error: "Missing action parameter" });
          return;
        }

        // Process the action...
        const result = await processAction(action, data);

        res.status(200).json({ result });
      },
    },

    // File upload endpoint
    {
      type: "POST",
      path: "/api/my-plugin/upload",
      isMultipart: true,
      handler: async (req, res, runtime) => {
        // Handle multipart form data...
        res.status(200).json({ uploaded: true });
      },
    },

    // Static file serving
    {
      type: "STATIC",
      path: "/my-plugin/assets",
      filePath: "./assets",
    },
  ],
};
```

---

<div id="event-handlers">

## Gestionnaires d'Événements

</div>

Les gestionnaires d'événements réagissent aux événements du runtime tels que les messages reçus, envoyés ou les connexions aux mondes.

<div id="available-events">

### Événements Disponibles

</div>

```typescript
type EventName =
  | "MESSAGE_RECEIVED"      // Inbound message from user/channel
  | "MESSAGE_SENT"          // Outbound message from agent
  | "VOICE_MESSAGE_RECEIVED" // Voice/audio message
  | "WORLD_CONNECTED"       // Connected to a world/server
  | "WORLD_JOINED"          // Joined a room/channel
  | "ACTION_STARTED"        // Action execution began
  | "ACTION_COMPLETED"      // Action execution finished
  // ... and more
```

<div id="event-handler-example">

### Exemple de Gestionnaire d'Événements

</div>

```typescript
import type { MessagePayload } from "@elizaos/core";

const myPlugin: Plugin = {
  name: "event-plugin",
  description: "Demonstrates event handling",

  events: {
    MESSAGE_RECEIVED: [
      async (payload: MessagePayload) => {
        const { runtime, message, source } = payload;

        // Log all incoming messages
        runtime.logger?.info(`[event-plugin] Message from ${source}:`, message.content?.text);

        // Inject metadata
        if (message.metadata) {
          (message.metadata as Record<string, unknown>).processedByEventPlugin = true;
        }
      },
    ],

    MESSAGE_SENT: [
      async (payload: MessagePayload) => {
        const { runtime, message } = payload;

        // Track outgoing messages
        runtime.logger?.info(`[event-plugin] Sent message:`, message.content?.text);
      },
    ],
  },
};
```

---

<div id="testing-plugins">

## Test des Plugins

</div>

<div id="unit-tests-with-vitest">

### Tests Unitaires avec Vitest

</div>

```typescript
// my-plugin.test.ts
import { describe, it, expect, vi } from "vitest";
import myPlugin from "./index";

describe("my-plugin", () => {
  it("has required properties", () => {
    expect(myPlugin.name).toBe("my-plugin");
    expect(myPlugin.description).toBeDefined();
  });

  it("greet action validates correctly", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");
    expect(greetAction).toBeDefined();

    const mockRuntime = { logger: console } as any;
    const mockMessage = { content: { text: "hello" } } as any;

    const isValid = await greetAction!.validate(mockRuntime, mockMessage);
    expect(isValid).toBe(true);
  });

  it("greet action returns greeting", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");

    const mockRuntime = { logger: console } as any;
    const mockMessage = { content: { text: "say hi to Bob" } } as any;
    const options = { parameters: { name: "Bob" } };

    const result = await greetAction!.handler(mockRuntime, mockMessage, undefined, options);

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Bob");
  });
});
```

<div id="integration-tests">

### Tests d'Intégration

</div>

```typescript
// integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRuntime } from "@elizaos/core";
import myPlugin from "./index";

describe("my-plugin integration", () => {
  let runtime: any;

  beforeAll(async () => {
    runtime = await createRuntime({
      plugins: [myPlugin],
      // Test configuration...
    });
  });

  afterAll(async () => {
    await runtime?.stop();
  });

  it("plugin initializes correctly", async () => {
    const service = runtime.getService("my_service");
    expect(service).toBeDefined();
  });
});
```

---

<div id="publishing-plugins">

## Publication des Plugins

</div>

<div id="npm-publishing">

### Publication sur npm

</div>

1. **Choisissez un nom de paquet :**
   - Officiel : `@elizaos/plugin-{name}`
   - Communauté : `elizaos-plugin-{name}` ou avec scope `@yourorg/plugin-{name}`

2. **Compilez votre plugin :**
   ```bash
   bun run build
   ```

3. **Publiez :**
   ```bash
   bun publish --access public
   ```

<div id="local-development">

### Développement Local

</div>

Pour le développement local de plugins sans publication :

1. **Découverte par workspace** — Placez votre plugin dans :
   - `./plugins/my-plugin/` (local au projet)
   - `~/.eliza/plugins/my-plugin/` (global)

2. **Chargement basé sur la configuration** — Ajoutez à `eliza.json` :
   ```json
   {
     "plugins": ["./path/to/my-plugin"]
   }
   ```

3. **Lien symbolique pour le développement :**
   ```bash
   cd ~/.eliza/plugins
   ln -s /path/to/my-plugin my-plugin
   ```

---

<div id="plugin-manifest-system">

## Système de Manifeste des Plugins

</div>

Les plugins peuvent inclure un fichier manifeste `elizaos.plugin.json` pour des métadonnées enrichies :

<div id="manifest-structure">

### Structure du Manifeste

</div>

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "A plugin that does awesome things",
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
      "label": "Timeout (ms)",
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

<div id="pluginkind-types">

### Types de PluginKind

</div>

| Kind | Description |
|------|-------------|
| `memory` | Adaptateurs de mémoire/stockage |
| `channel` | Connecteurs de plateformes de messagerie |
| `provider` | Fournisseurs de contexte/données |
| `skill` | Extensions basées sur les compétences |
| `database` | Adaptateurs de base de données |

<div id="pluginorigin-types">

### Types de PluginOrigin

</div>

Indique où un plugin a été découvert :

| Origin | Description |
|--------|-------------|
| `bundled` | Livré avec Eliza |
| `global` | Depuis `~/.eliza/plugins/` |
| `workspace` | Depuis `./plugins/` |
| `config` | Listé explicitement dans la configuration |
| `npm` | Paquet npm installé |

---

<div id="evaluators">

## Evaluators

</div>

Les evaluators évaluent les réponses de l'agent et peuvent déclencher des actions de suivi.

<div id="evaluator-interface">

### Interface de l'Evaluator

</div>

```typescript
interface Evaluator {
  /** Evaluator name */
  name: string;

  /** Description of what this evaluator checks */
  description: string;

  /** Always run this evaluator (vs. sampled) */
  alwaysRun?: boolean;

  /** Similar evaluator descriptions */
  similes?: string[];

  /** Example evaluations for LLM guidance */
  examples: EvaluationExample[];

  /** Validation function */
  validate: Validator;

  /** Handler that performs the evaluation */
  handler: Handler;
}
```

<div id="evaluator-example">

### Exemple d'Evaluator

</div>

```typescript
const factCheckEvaluator: Evaluator = {
  name: "FACT_CHECK",
  description: "Verify factual claims in responses",
  alwaysRun: false,

  examples: [
    {
      messages: [
        { user: "user", content: { text: "What's the capital of France?" } },
        { user: "assistant", content: { text: "Paris is the capital of France." } },
      ],
    },
  ],

  validate: async (runtime, message) => {
    // Only evaluate responses with factual claims
    const text = message.content?.text ?? "";
    return text.includes("is") || text.includes("was");
  },

  handler: async (runtime, message, state) => {
    // Perform fact checking...
    return {
      success: true,
      text: "Fact check passed",
      data: { verified: true },
    };
  },
};
```

---

<div id="model-overrides">

## Surcharges de Modèles

</div>

Les plugins peuvent enregistrer des gestionnaires de modèles personnalisés pour des types d'inférence spécifiques.

<div id="available-model-types">

### Types de Modèles Disponibles

</div>

```typescript
const ModelType = {
  // Text generation
  TEXT_SMALL: "TEXT_SMALL",       // Fast, cheap, simple tasks
  TEXT_LARGE: "TEXT_LARGE",       // Complex reasoning
  TEXT_COMPLETION: "TEXT_COMPLETION",

  // Embeddings
  TEXT_EMBEDDING: "TEXT_EMBEDDING",

  // Tokenization
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",

  // Media
  IMAGE: "IMAGE",                          // Image generation
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",  // Vision/analysis
  TRANSCRIPTION: "TRANSCRIPTION",          // Speech-to-text
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",        // TTS
  AUDIO: "AUDIO",                          // Audio processing
  VIDEO: "VIDEO",                          // Video processing

  // Research
  RESEARCH: "RESEARCH",
};
```

<div id="registering-model-handlers">

### Enregistrement des Gestionnaires de Modèles

</div>

```typescript
const myPlugin: Plugin = {
  name: "custom-model-plugin",
  description: "Provides custom model handlers",

  models: {
    TEXT_SMALL: async (runtime, params) => {
      const { prompt, maxTokens, temperature } = params as GenerateTextParams;

      // Call your custom model...
      const response = await myCustomModel.generate(prompt, {
        maxTokens,
        temperature,
      });

      return {
        text: response.content,
        usage: {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
        },
      };
    },

    IMAGE: async (runtime, params) => {
      const { prompt, width, height } = params as ImageGenerationParams;

      const imageUrl = await myImageModel.generate(prompt, width, height);

      return {
        images: [{ url: imageUrl }],
      };
    },
  },
};
```

---

<div id="entity-component-types">

## Types de Composants d'Entité

</div>

Les plugins peuvent définir des types de composants personnalisés pour les entités :

```typescript
const myPlugin: Plugin = {
  name: "entity-plugin",
  description: "Adds custom entity components",

  componentTypes: [
    {
      name: "userPreferences",
      schema: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
          language: { type: "string" },
          notifications: { type: "boolean" },
        },
        required: ["theme"],
      },
      validator: (data) => {
        return data.theme === "light" || data.theme === "dark";
      },
    },
  ],
};
```

---

<div id="config-schema-validation-with-zod">

## Validation du Schéma de Configuration avec Zod

</div>

Utilisez Zod pour la validation à l'exécution de la configuration du plugin :

```typescript
import { z } from "zod";
import type { Plugin } from "@elizaos/core";

// Define config schema
const ConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  baseUrl: z.string().url().optional(),
  timeout: z.number().positive().default(30000),
  retries: z.number().int().min(0).max(10).default(3),
  debug: z.boolean().default(false),
});

type PluginConfig = z.infer<typeof ConfigSchema>;

const myPlugin: Plugin = {
  name: "validated-plugin",
  description: "Plugin with Zod-validated config",

  init: async (config, runtime) => {
    // Validate and parse config
    const parsed = ConfigSchema.safeParse(config);

    if (!parsed.success) {
      const errors = parsed.error.errors
        .map(e => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new Error(`Invalid config: ${errors}`);
    }

    const validConfig: PluginConfig = parsed.data;

    runtime.logger?.info("[validated-plugin] Config validated", {
      baseUrl: validConfig.baseUrl,
      timeout: validConfig.timeout,
      debug: validConfig.debug,
    });

    // Use validated config...
  },
};
```

---

<div id="best-practices">

## Bonnes Pratiques

</div>

1. **Noms descriptifs** — Les noms des actions doivent être clairs et en MAJUSCULES_AVEC_UNDERSCORES
2. **Bons exemples** — Fournissez des exemples de conversation pour que le LLM sache quand utiliser votre action
3. **Validez les entrées** — Validez toujours les paramètres avant de les utiliser
4. **Gérez les erreurs avec élégance** — Retournez des messages d'erreur significatifs dans ActionResult
5. **Journalisez correctement** — Utilisez `runtime.logger` pour le débogage, pas console.log
6. **Nettoyez les ressources** — Les services doivent s'arrêter correctement et libérer les ressources
7. **Documentez la configuration** — Listez les variables d'environnement et paramètres requis
8. **Testez rigoureusement** — Tests unitaires pour les actions/providers, tests d'intégration pour le plugin complet
9. **Utilisez Zod pour la configuration** — La validation à l'exécution détecte les erreurs de configuration tôt
10. **Incluez le manifeste** — Ajoutez `elizaos.plugin.json` pour une intégration UI enrichie

---

<div id="next-steps">

## Prochaines Étapes

</div>

- [Documentation des Skills](/fr/plugins/skills) — Apprenez les extensions de compétences basées sur markdown
- [Guide du Registre](/fr/plugins/registry) — Publication dans le registre de plugins
- [Guide de Contribution](/fr/guides/contributing) — Contribuer à Eliza/elizaOS
