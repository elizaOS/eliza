---
title: "Desarrollo de Plugins"
sidebarTitle: "Desarrollo de Plugins"
description: "Crea, prueba y publica plugins para Eliza/elizaOS."
---

Esta guía te lleva paso a paso por la creación, prueba y publicación de plugins para Eliza/elizaOS.

<div id="table-of-contents">

## Tabla de Contenidos

</div>

1. [Descripción General de la Arquitectura de Plugins](#plugin-architecture-overview)
2. [Creando Tu Primer Plugin](#creating-your-first-plugin)
3. [Actions](#actions)
4. [Providers](#providers)
5. [Services](#services)
6. [Routes](#routes)
7. [Manejadores de Eventos](#event-handlers)
8. [Pruebas de Plugins](#testing-plugins)
9. [Publicación de Plugins](#publishing-plugins)

---

<div id="plugin-architecture-overview">

## Descripción General de la Arquitectura de Plugins

</div>

Un plugin es una extensión modular que añade capacidades a un agente de elizaOS. Los plugins pueden proporcionar:

- **Actions** — Cosas que el agente puede hacer (enviar mensajes, generar imágenes, reiniciar)
- **Providers** — Contexto inyectado en los prompts del agente (archivos del workspace, estado de sesión)
- **Services** — Procesos en segundo plano de larga duración (servidores WebSocket, bucles de sondeo)
- **Routes** — Endpoints HTTP expuestos por la API del agente
- **Manejadores de Eventos** — Callbacks para eventos del runtime (mensaje recibido, enviado, etc.)
- **Evaluators** — Lógica de evaluación para las respuestas del agente
- **Models** — Manejadores de modelos personalizados para tipos de inferencia específicos

<div id="the-plugin-interface">

### La Interfaz del Plugin

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

### Ciclo de Vida del Plugin

</div>

1. **Descubrimiento** — Los plugins se descubren desde:
   - Plugins incluidos (enviados con Eliza)
   - Plugins del workspace (`./plugins/`)
   - Plugins globales (`~/.eliza/plugins/`)
   - Paquetes npm (`@elizaos/plugin-*`)
   - Plugins especificados en la configuración

2. **Carga** — Los módulos de los plugins se importan y validan

3. **Resolución de Dependencias** — Los plugins se ordenan por dependencias y prioridad

4. **Inicialización** — Se llama a `plugin.init(config, runtime)` para cada plugin

5. **Registro** — Las actions, providers, services, routes y eventos se registran en el runtime

---

<div id="creating-your-first-plugin">

## Creando Tu Primer Plugin

</div>

<div id="minimal-plugin-structure">

### Estructura Mínima del Plugin

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

Las actions son cosas que el agente puede hacer. El LLM elige invocar una action basándose en el contexto de la conversación y la descripción/ejemplos de la action.

<div id="action-interface">

### Interfaz de Action

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

### Parámetros de Action

</div>

Los parámetros permiten al LLM extraer datos estructurados de la conversación:

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

### Resultado de Action

</div>

Las actions devuelven un objeto `ActionResult`:

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

Los providers inyectan contexto en el prompt del agente. Se llaman antes de cada inferencia del LLM para suministrar información relevante.

<div id="provider-interface">

### Interfaz de Provider

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

### Resultado de Provider

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

### Ejemplo de Provider

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

Los services son procesos en segundo plano de larga duración. Se inician cuando el runtime se inicializa y se detienen cuando se apaga.

<div id="creating-a-service">

### Creando un Service

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

### Usando Services en un Plugin

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

Las routes exponen endpoints HTTP a través del servidor API del agente.

<div id="route-types">

### Tipos de Route

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

### Ejemplo de Route

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

## Manejadores de Eventos

</div>

Los manejadores de eventos reaccionan a eventos del runtime como mensajes recibidos, enviados o conexiones de mundos.

<div id="available-events">

### Eventos Disponibles

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

### Ejemplo de Manejador de Eventos

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

## Pruebas de Plugins

</div>

<div id="unit-tests-with-vitest">

### Pruebas Unitarias con Vitest

</div>

```typescript
// my-plugin.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMessageMemory, stringToUuid, type Memory } from "@elizaos/core";
import { createTestRuntime, type TestRuntimeResult } from "@elizaos/core";
import myPlugin from "./index";

function createTestMessage(text: string): Memory {
  return createMessageMemory({
    entityId: stringToUuid("test-user"),
    roomId: stringToUuid("test-room"),
    content: { text },
  });
}

describe("my-plugin", () => {
  let testRuntime: TestRuntimeResult;

  beforeAll(async () => {
    testRuntime = await createTestRuntime();
  });

  afterAll(async () => {
    await testRuntime.cleanup();
  });

  it("has required properties", () => {
    expect(myPlugin.name).toBe("my-plugin");
    expect(myPlugin.description).toBeDefined();
  });

  it("greet action validates correctly", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");
    expect(greetAction).toBeDefined();

    const mockRuntime = testRuntime.runtime;
    const mockMessage = createTestMessage("hello");

    const isValid = await greetAction!.validate(mockRuntime, mockMessage);
    expect(isValid).toBe(true);
  });

  it("greet action returns greeting", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");

    const mockRuntime = testRuntime.runtime;
    const mockMessage = createTestMessage("say hi to Bob");
    const options = { parameters: { name: "Bob" } };

    const result = await greetAction!.handler(mockRuntime, mockMessage, undefined, options);

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Bob");
  });
});
```

<div id="integration-tests">

### Pruebas de Integración

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

## Publicación de Plugins

</div>

<div id="npm-publishing">

### Publicación en npm

</div>

1. **Elige un nombre de paquete:**
   - Oficial: `@elizaos/plugin-{name}`
   - Comunidad: `elizaos-plugin-{name}` o con scope `@yourorg/plugin-{name}`

2. **Compila tu plugin:**
   ```bash
   bun run build
   ```

3. **Publica:**
   ```bash
   bun publish --access public
   ```

<div id="local-development">

### Desarrollo Local

</div>

Para desarrollo local de plugins sin publicar:

1. **Descubrimiento por workspace** — Coloca tu plugin en:
   - `./plugins/my-plugin/` (local al proyecto)
   - `~/.eliza/plugins/my-plugin/` (global)

2. **Carga basada en configuración** — Añade a `eliza.json`:
   ```json
   {
     "plugins": ["./path/to/my-plugin"]
   }
   ```

3. **Enlace simbólico para desarrollo:**
   ```bash
   cd ~/.eliza/plugins
   ln -s /path/to/my-plugin my-plugin
   ```

---

<div id="plugin-manifest-system">

## Sistema de Manifiesto de Plugins

</div>

Los plugins pueden incluir un archivo de manifiesto `elizaos.plugin.json` para metadatos enriquecidos:

<div id="manifest-structure">

### Estructura del Manifiesto

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

### Tipos de PluginKind

</div>

| Kind | Descripción |
|------|-------------|
| `memory` | Adaptadores de memoria/almacenamiento |
| `channel` | Conectores de plataformas de mensajería |
| `provider` | Proveedores de contexto/datos |
| `skill` | Extensiones basadas en habilidades |
| `database` | Adaptadores de base de datos |

<div id="pluginorigin-types">

### Tipos de PluginOrigin

</div>

Indica dónde se descubrió un plugin:

| Origin | Descripción |
|--------|-------------|
| `bundled` | Incluido con Eliza |
| `global` | Desde `~/.eliza/plugins/` |
| `workspace` | Desde `./plugins/` |
| `config` | Listado explícitamente en la configuración |
| `npm` | Paquete npm instalado |

---

<div id="evaluators">

## Evaluators

</div>

Los evaluators evalúan las respuestas del agente y pueden activar acciones de seguimiento.

<div id="evaluator-interface">

### Interfaz de Evaluator

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

### Ejemplo de Evaluator

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

## Sobrecargas de Modelos

</div>

Los plugins pueden registrar manejadores de modelos personalizados para tipos de inferencia específicos.

<div id="available-model-types">

### Tipos de Modelos Disponibles

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

### Registro de Manejadores de Modelos

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

## Tipos de Componentes de Entidad

</div>

Los plugins pueden definir tipos de componentes personalizados para entidades:

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

## Validación de Esquema de Configuración con Zod

</div>

Usa Zod para la validación en tiempo de ejecución de la configuración del plugin:

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

## Mejores Prácticas

</div>

1. **Nombres descriptivos** — Los nombres de las actions deben ser claros y usar MAYUSCULAS_CON_GUIONES_BAJOS
2. **Buenos ejemplos** — Proporciona ejemplos de conversación para que el LLM sepa cuándo usar tu action
3. **Valida las entradas** — Siempre valida los parámetros antes de usarlos
4. **Maneja errores con gracia** — Devuelve mensajes de error significativos en ActionResult
5. **Registra apropiadamente** — Usa `runtime.logger` para depuración, no console.log
6. **Limpia recursos** — Los services deben detenerse correctamente y liberar recursos
7. **Documenta la configuración** — Lista las variables de entorno y configuraciones requeridas
8. **Prueba exhaustivamente** — Pruebas unitarias para actions/providers, pruebas de integración para el plugin completo
9. **Usa Zod para configuración** — La validación en tiempo de ejecución detecta errores de configuración temprano
10. **Incluye manifiesto** — Añade `elizaos.plugin.json` para una integración de UI enriquecida

---

<div id="next-steps">

## Próximos Pasos

</div>

- [Documentación de Skills](/es/plugins/skills) — Aprende sobre extensiones de habilidades basadas en markdown
- [Guía del Registro](/es/plugins/registry) — Publicación en el registro de plugins
- [Guía de Contribución](/es/guides/contributing) — Contribuir a Eliza/elizaOS
