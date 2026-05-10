---
title: "Runtime principal"
sidebarTitle: "Core"
description: "Clase AgentRuntime, parámetros del constructor, registro de plugins y la cascada de configuración de Eliza."
---

La clase `AgentRuntime` de `@elizaos/core` es el objeto central que gestiona el registro de plugins, procesamiento de mensajes, ensamblaje de contexto de proveedores y ciclo de vida de servicios. Eliza la envuelve con lógica de arranque adicional en `src/runtime/eliza.ts`.

<div id="agentruntime-constructor">
## Constructor de AgentRuntime
</div>

```typescript
const runtime = new AgentRuntime({
  character,
  actionPlanning: true,
  plugins: [elizaPlugin, ...resolvedPlugins],
  logLevel: "error",
  // sandboxMode and sandboxAuditHandler are only included when sandbox is active
  ...(isSandboxActive && {
    sandboxMode: true,
    sandboxAuditHandler: handleSandboxAudit,
  }),
  settings: {
    VALIDATION_LEVEL: "fast",
    MODEL_PROVIDER: "anthropic/claude-sonnet-4.6",
    BUNDLED_SKILLS_DIRS: "/path/to/skills",
    WORKSPACE_SKILLS_DIR: "~/.eliza/workspace/skills",
    SKILLS_ALLOWLIST: "skill-a,skill-b",
    SKILLS_DENYLIST: "skill-x",
  },
});
```

<div id="constructor-parameters">
### Parámetros del constructor
</div>

| Parámetro | Tipo | Descripción |
|---|---|---|
| `character` | `Character` | La identidad, personalidad y secretos del agente. Construido por `buildCharacterFromConfig()`. |
| `actionPlanning` | `boolean` | Activa el subsistema de planificación de acciones. Eliza lo establece en `true`. |
| `plugins` | `Plugin[]` | Array ordenado de plugins. El plugin Eliza va primero, luego los plugins resueltos. |
| `logLevel` | `string` | Nivel de verbosidad de logs: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`. Se resuelve desde `config.logging.level`. |
| `sandboxMode` | `boolean` | Activa el reemplazo de tokens en sandbox para registro de auditoría. Solo se incluye en el constructor cuando `isSandboxActive` es verdadero (es decir, `agents.defaults.sandbox.mode != "off"`). Cuando el sandbox está desactivado, este parámetro no se pasa. |
| `sandboxAuditHandler` | `function` | Callback para eventos de auditoría de fetch en sandbox. Recibe `{ direction, url, tokenIds }`. |
| `settings` | `Record<string, string>` | Configuraciones del runtime pasadas a los plugins vía `runtime.getSetting()`. |

<div id="key-settings">
## Configuraciones clave
</div>

| Clave de configuración | Origen | Descripción |
|---|---|---|
| `VALIDATION_LEVEL` | Hardcoded | Establecido en `"fast"` — controla la profundidad de validación de elizaOS |
| `MODEL_PROVIDER` | `agents.defaults.model.primary` | Selección del modelo primario (por ej., `"anthropic/claude-sonnet-4.6"`) |
| `BUNDLED_SKILLS_DIRS` | paquete `@elizaos/skills` | Ruta absoluta al directorio de habilidades incluidas |
| `WORKSPACE_SKILLS_DIR` | ruta del workspace + `/skills` | Directorio de sobrecargas de habilidades por agente |
| `EXTRA_SKILLS_DIRS` | `skills.load.extraDirs` | Directorios adicionales de habilidades desde la configuración |
| `SKILLS_ALLOWLIST` | `skills.allowBundled` | Lista separada por comas de habilidades incluidas permitidas |
| `SKILLS_DENYLIST` | `skills.denyBundled` | Lista separada por comas de habilidades incluidas denegadas |
| `DISABLE_IMAGE_DESCRIPTION` | `features.vision == false` | Previene la descripción de imágenes incluso cuando el plugin de la nube está cargado |

<div id="plugin-registration">
## Registro de plugins
</div>

Eliza registra plugins en dos fases:

<div id="phase-1-pre-registration-sequential">
### Fase 1: Pre-registro (secuencial)
</div>

```typescript
// 1. SQL plugin — must be first so DB adapter is ready
// Wrapped in registerSqlPluginWithRecovery() which catches PGLite corruption,
// resets the data directory, and retries registration once.
await registerSqlPluginWithRecovery(runtime, sqlPlugin.plugin, config);
await initializeDatabaseAdapter(runtime, config);

// 2. Local embedding — must be second so TEXT_EMBEDDING handler is ready
configureLocalEmbeddingPlugin(localEmbeddingPlugin.plugin, config);
await runtime.registerPlugin(localEmbeddingPlugin.plugin);
```

<Note>
**Recuperación del plugin SQL**: `registerSqlPluginWithRecovery()` envuelve el registro del plugin SQL en un try/catch. Si el registro inicial falla debido a un estado corrupto de PGLite, el envoltorio elimina el directorio de datos de PGLite, registra una advertencia y reintenta el registro desde cero. Esto previene que el agente quede permanentemente atascado después de que un crash corrompa la base de datos local.
</Note>

<div id="phase-2-full-initialization-parallel">
### Fase 2: Inicialización completa (paralela)
</div>

```typescript
// All remaining plugins initialize in parallel
await runtime.initialize();
```

`runtime.initialize()` llama a `init()` en cada plugin registrado e inicia todos los servicios registrados.

<div id="plugin-export-detection">
## Detección de exportación de plugins
</div>

`findRuntimePluginExport()` en `src/runtime/eliza.ts` localiza la exportación Plugin de un módulo importado dinámicamente usando un orden de prioridad:

```
1. module.default   (exportación por defecto de módulo ES)
2. module.plugin    (exportación nombrada "plugin")
3. module itself    (patrón por defecto CJS)
4. Named exports ending in "Plugin" or starting with "plugin"
5. Other named exports that match Plugin shape
6. Minimal { name, description } exports for named keys matching "plugin"
```

<div id="plugin-shape-validation">
## Validación de forma de plugin
</div>

Una exportación de módulo se acepta como Plugin cuando tiene los campos `name` y `description` más al menos uno de:

```typescript
Array.isArray(obj.services) ||
Array.isArray(obj.providers) ||
Array.isArray(obj.actions) ||
Array.isArray(obj.routes) ||
Array.isArray(obj.events) ||
typeof obj.init === "function"
```

<div id="collectpluginnames">
## collectPluginNames
</div>

`collectPluginNames(config)` produce el conjunto completo de nombres de paquetes de plugins a cargar:

```typescript
// Core plugins — always loaded
const pluginsToLoad = new Set<string>(CORE_PLUGINS);

// allow list — additive, not exclusive
for (const item of config.plugins?.allow ?? []) {
  pluginsToLoad.add(CHANNEL_PLUGIN_MAP[item] ?? OPTIONAL_PLUGIN_MAP[item] ?? item);
}

// Connector plugins — from config.connectors entries
for (const [channelName] of Object.entries(connectors)) {
  pluginsToLoad.add(CHANNEL_PLUGIN_MAP[channelName]);
}

// Provider plugins — from environment variables
for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
  if (process.env[envKey]) pluginsToLoad.add(pluginName);
}

// Feature flags
for (const [featureName, enabled] of Object.entries(config.features ?? {})) {
  if (enabled) pluginsToLoad.add(OPTIONAL_PLUGIN_MAP[featureName]);
}
```

<Note>
**Exclusión del plugin Eliza Cloud**: Cuando Eliza Cloud está efectivamente habilitado (la clave API de la nube está configurada y el plugin de la nube está cargado), los plugins de proveedores de IA directos (por ej., `@elizaos/plugin-anthropic`, `@elizaos/plugin-openai`) se eliminan del conjunto de carga. El plugin de la nube enruta las solicitudes de modelos a través de Eliza Cloud, por lo que cargar plugins de proveedores individuales sería redundante y podría causar conflictos de enrutamiento.
</Note>

<div id="channel-to-plugin-mapping">
## Mapeo de canal a plugin
</div>

```typescript
const CHANNEL_PLUGIN_MAP = {
  telegram:    "@elizaos/plugin-telegram",
  discord:     "@elizaos/plugin-discord",
  slack:       "@elizaos/plugin-slack",
  twitter:     "@elizaos/plugin-x",
  whatsapp:    "@elizaos/plugin-whatsapp",
  signal:      "@elizaos/plugin-signal",
  imessage:    "@elizaos/plugin-imessage",
  farcaster:   "@elizaos/plugin-farcaster",
  lens:        "@elizaos/plugin-lens",
  msteams:     "@elizaos/plugin-msteams",
  mattermost:  "@elizaos/plugin-mattermost",
  googlechat:  "@elizaos/plugin-google-chat",
  feishu:      "@elizaos/plugin-feishu",
  matrix:      "@elizaos/plugin-matrix",
  nostr:       "@elizaos/plugin-nostr",
  blooio:      "@elizaos/plugin-blooio",
  twitch:      "@elizaos/plugin-twitch",
};
```

<div id="provider-to-plugin-mapping">
## Mapeo de proveedor a plugin
</div>

```typescript
const PROVIDER_PLUGIN_MAP = {
  ANTHROPIC_API_KEY:              "@elizaos/plugin-anthropic",
  CLAUDE_API_KEY:                 "@elizaos/plugin-anthropic",
  OPENAI_API_KEY:                 "@elizaos/plugin-openai",
  AI_GATEWAY_API_KEY:             "@elizaos/plugin-vercel-ai-gateway",
  AIGATEWAY_API_KEY:              "@elizaos/plugin-vercel-ai-gateway",
  GOOGLE_API_KEY:                 "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY:   "@elizaos/plugin-google-genai",
  GOOGLE_CLOUD_API_KEY:           "@elizaos/plugin-google-antigravity",
  GROQ_API_KEY:                   "@elizaos/plugin-groq",
  XAI_API_KEY:                    "@elizaos/plugin-xai",
  GROK_API_KEY:                   "@elizaos/plugin-xai",
  OPENROUTER_API_KEY:             "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL:                "@elizaos/plugin-ollama",
  ZAI_API_KEY:                    "@homunculuslabs/plugin-zai",
  DEEPSEEK_API_KEY:               "@elizaos/plugin-deepseek",
  TOGETHER_API_KEY:               "@elizaos/plugin-together",
  MISTRAL_API_KEY:                "@elizaos/plugin-mistral",
  COHERE_API_KEY:                 "@elizaos/plugin-cohere",
  PERPLEXITY_API_KEY:             "@elizaos/plugin-perplexity",
  ELIZAOS_CLOUD_API_KEY:          "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED:          "@elizaos/plugin-elizacloud",
  CUA_API_KEY:                    "@elizaos/plugin-cua",
  CUA_HOST:                       "@elizaos/plugin-cua",
  OBSIDIAN_VAULT_PATH:            "@elizaos/plugin-obsidian",
  REPOPROMPT_CLI_PATH:            "@elizaos/plugin-repoprompt",

};
```

<div id="error-boundaries">
## Límites de error
</div>

Cada `init()` y `providers` de un plugin están envueltos con límites de error vía `wrapPluginWithErrorBoundary()`. Un crash en `init()` registra el error y pone al plugin en modo degradado. Un crash en el `get()` de un proveedor retorna un texto marcador de error en lugar de lanzar:

```typescript
return {
  text: `[Provider ${provider.name} error: ${msg}]`,
  data: { _providerError: true },
};
```

<div id="method-bindings">
## Vinculaciones de métodos
</div>

`installRuntimeMethodBindings()` vincula ciertos métodos del runtime a la instancia del runtime para prevenir la pérdida de contexto `this` cuando el método se almacena e invoca por plugins:

```typescript
runtime.getConversationLength = runtime.getConversationLength.bind(runtime);
```

<div id="configuration-cascade">
## Cascada de configuración
</div>

Los valores de configuración se aplican en cascada desde múltiples fuentes en este orden de prioridad:

```
process.env (máxima prioridad)
  ↓
eliza.json (archivo de configuración)
  ↓
Objeto settings de AgentRuntime
  ↓
Valores predeterminados del plugin (mínima prioridad)
```

<div id="related-pages">
## Páginas relacionadas
</div>

- [Runtime y ciclo de vida](/es/agents/runtime-and-lifecycle) — la secuencia completa de arranque
- [Servicios](/es/runtime/services) — registro y ciclo de vida de servicios
- [Proveedores](/es/runtime/providers) — interfaz de proveedores e inyección de contexto
- [Modelos](/es/runtime/models) — selección y configuración de proveedores de modelos
