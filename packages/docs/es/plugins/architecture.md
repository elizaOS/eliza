---
title: "Arquitectura de Plugins"
sidebarTitle: "Arquitectura"
description: "Análisis profundo del sistema de plugins de Eliza — ciclo de vida del registro, puntos de enganche, mecanismo de auto-habilitación y resolución de dependencias."
---

El sistema de plugins de Eliza está construido sobre el núcleo de elizaOS. Toda capacidad más allá del runtime base — proveedores de modelos, conectores de plataformas, integraciones DeFi, programación de tareas y funcionalidades personalizadas — se entrega como un plugin.

<div id="system-design">

## Diseño del Sistema

</div>

Los plugins son módulos aislados que registran capacidades con el `AgentRuntime`. El runtime orquesta la carga de plugins, la resolución de dependencias, la inicialización y el apagado.

```
AgentRuntime
├── Core Plugins     (siempre cargados)
├── Auto-enabled     (activados por variables de entorno / configuración)
├── Character        (especificados en el archivo de personaje)
└── Local            (desde el directorio plugins/)
```

La fuente de verdad sobre qué plugins se cargan siempre se encuentra en `eliza/packages/agent/src/runtime/core-plugins.ts` (en el submódulo upstream de elizaOS, re-exportado por `eliza/packages/app-core/src/runtime/core-plugins.ts`):

```typescript
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",               // database adapter — required
  "@elizaos/plugin-local-embedding",   // local embeddings — required for memory
  "knowledge",         // RAG knowledge management — required for knowledge tab
  "trajectories", // trajectory logging for debugging and RL training
  "@elizaos/plugin-agent-orchestrator",// multi-agent orchestration (PTY, SwarmCoordinator, workspace provisioning)
  "@elizaos/plugin-shell",             // shell command execution
  "@elizaos/plugin-coding-tools",      // native Read/Write/Edit/Bash/Grep/Glob (desktop; CODING_TOOLS_DISABLE)
  "@elizaos/plugin-agent-skills",      // skill execution and marketplace runtime
  "@elizaos/plugin-commands",          // slash command handling (skills auto-register as /commands)
  "roles",                            // internal role-based access control (OWNER/ADMIN/NONE)
];
```

> **Nota:** Varias capacidades que antes eran plugins independientes son ahora características integradas del runtime: experience, form, clipboard, personality (capacidades avanzadas con `advancedCapabilities: true`), trust (con `enableTrust: true`), secretos (con `enableSecretsManager: true`), plugin-manager (con `enablePluginManager: true`), knowledge, relationships y trajectories (funciones nativas). El agent-orchestrator es opcional vía `ELIZA_AGENT_ORCHESTRATOR` (la app Eliza lo habilita por defecto).

<div id="optional-core-plugins">

### Plugins Principales Opcionales

</div>

Una lista separada de plugins principales opcionales puede habilitarse desde el panel de administración. No se cargan por defecto debido a restricciones de empaquetado o especificación. La lista se encuentra en `eliza/packages/agent/src/runtime/core-plugins.ts`:

```typescript
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-pdf",                   // PDF processing
  "@elizaos/plugin-cua",                   // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian",              // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt",            // RepoPrompt CLI integration
  "@elizaos/plugin-claude-code-workbench", // Claude Code companion workflows
  "@elizaos/plugin-computeruse",           // computer use automation (platform-specific)
  "@elizaos/plugin-browser",              // browser automation (requires stagehand-server)
  "@elizaos/plugin-vision",               // vision/image understanding (feature-gated)
  "@elizaos/plugin-cli",                  // CLI interface
  "@elizaos/plugin-discord",              // Discord bot integration
  "@elizaos/plugin-telegram",             // Telegram bot integration
  "@elizaos/plugin-twitch",               // Twitch integration
  "@elizaos/plugin-edge-tts",             // text-to-speech (Microsoft Edge TTS)
  "@elizaos/plugin-elevenlabs",           // ElevenLabs text-to-speech
];
```

Plugins como `@elizaos/plugin-directives`, `@elizaos/plugin-commands`, `@elizaos/plugin-mcp` y `@elizaos/plugin-scheduling` están comentados en el código fuente y podrían activarse en versiones futuras.

<div id="plugin-hook-points">

## Puntos de Enganche de Plugins

</div>

Un plugin puede registrar cualquier combinación de los siguientes puntos de enganche:

| Enganche | Tipo | Propósito |
|----------|------|-----------|
| `actions` | `Action[]` | Cosas que el agente puede hacer; el LLM selecciona acciones de esta lista |
| `providers` | `Provider[]` | Contexto inyectado en el prompt antes de cada llamada al LLM |
| `evaluators` | `Evaluator[]` | Evaluación posterior a la respuesta; puede desencadenar acciones de seguimiento |
| `services` | `ServiceClass[]` | Procesos en segundo plano de larga duración |
| `routes` | `Route[]` | Endpoints HTTP expuestos por el servidor API del agente |
| `events` | `Record<EventName, Handler[]>` | Callbacks para eventos del runtime |
| `models` | `Record<ModelType, Handler>` | Manejadores personalizados de inferencia de modelos |

<div id="registration-lifecycle">

## Ciclo de Vida del Registro

</div>

```
1. Resolve      — El paquete del plugin es localizado (npm, local, workspace)
2. Import       — El módulo es importado dinámicamente y su forma es validada
3. Sort         — Los plugins se ordenan por dependencias y campo de prioridad
4. Init         — Se llama a plugin.init(config, runtime)
5. Register     — Se registran actions, providers, services, routes y events
6. Active       — El plugin responde a mensajes y eventos
7. Shutdown     — Se llama a plugin.cleanup() / service.stop() al salir
```

<div id="plugin-interface">

### Interfaz del Plugin

</div>

```typescript
interface Plugin {
  name: string;
  description: string;

  // Lifecycle
  init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void>;

  // Hook points
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  services?: ServiceClass[];
  routes?: Route[];
  events?: Record<string, Handler[]>;
  models?: Record<string, ModelHandler>;
  componentTypes?: ComponentType[];

  // Load order
  priority?: number;          // Higher = loaded later
  dependencies?: string[];    // Other plugin names this depends on
  tests?: TestSuite[];
}
```

<div id="auto-enable-mechanism">

## Mecanismo de Auto-Habilitación

</div>

Los plugins se habilitan automáticamente cuando se detecta su configuración requerida. Esta lógica se encuentra en `eliza/packages/agent/src/config/plugin-auto-enable.ts` (extendida por el `plugin-auto-enable.ts` de Eliza para conectores como WeChat) y se ejecuta antes de la inicialización del runtime.

<div id="trigger-sources">

### Fuentes de Activación

</div>

**Claves API de variables de entorno** — El mapa `AUTH_PROVIDER_PLUGINS` conecta variables de entorno con nombres de paquetes de plugins:

```typescript
const AUTH_PROVIDER_PLUGINS = {
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
  CLAUDE_CODE_WORKBENCH_ENABLED:  "@elizaos/plugin-claude-code-workbench",
};
```

**Configuración de conectores** — Los bloques de conectores con un campo `botToken`, `token` o `apiKey` habilitan automáticamente el plugin conector correspondiente:

```typescript
const CONNECTOR_PLUGINS = {
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
  wechat:      "@elizaos/plugin-wechat",  // Eliza-specific (added in app-core)
};
```

> **Nota:** El paquete upstream `packages/agent` define todos los conectores `@elizaos/*`. El `packages/app-core` de Eliza extiende este mapa con la entrada `wechat` apuntando a `@elizaos/plugin-wechat`.

**Flags de funcionalidades** — La sección `features` de `eliza.json` habilita automáticamente los plugins de funcionalidades. Una funcionalidad puede habilitarse con `features.<name>: true` o `features.<name>.enabled: true`:

```json
{
  "features": {
    "browser": true,
    "imageGen": true,
    "tts": { "enabled": true }
  }
}
```

El mapa completo de `FEATURE_PLUGINS`:

```typescript
const FEATURE_PLUGINS = {
  browser:              "@elizaos/plugin-browser",
  cua:                  "@elizaos/plugin-cua",
  obsidian:             "@elizaos/plugin-obsidian",
  shell:                "@elizaos/plugin-shell",
  imageGen:             "@elizaos/plugin-image-generation",
  tts:                  "@elizaos/plugin-tts",
  stt:                  "@elizaos/plugin-stt",
  agentSkills:          "@elizaos/plugin-agent-skills",
  commands:             "@elizaos/plugin-commands",
  diagnosticsOtel:      "@elizaos/plugin-diagnostics-otel",
  webhooks:             "@elizaos/plugin-webhooks",
  gmailWatch:           "@elizaos/plugin-gmail-watch",
  x402:                 "@elizaos/plugin-x402",
  fal:                  "@elizaos/plugin-fal",
  suno:                 "@elizaos/plugin-suno",
  vision:               "@elizaos/plugin-vision",
  computeruse:          "@elizaos/plugin-computeruse",
  repoprompt:           "@elizaos/plugin-repoprompt",
  claudeCodeWorkbench:  "@elizaos/plugin-claude-code-workbench",
};
```

> **Nota:** `personality`, `experience` y `form` ya no son paquetes listados en el mapa de feature flags — son capacidades avanzadas integradas en `@elizaos/core`, habilitadas con `advancedCapabilities: true` en la configuración del personaje.

**Destinos de streaming** — La sección `streaming` de la configuración habilita automáticamente los plugins de streaming para plataformas de video en vivo:

```typescript
const STREAMING_PLUGINS = {
  twitch:       "@elizaos/plugin-streaming",
  youtube:      "@elizaos/plugin-streaming",
  customRtmp:   "@elizaos/plugin-streaming",
  pumpfun:      "@elizaos/plugin-streaming",
  x:            "@elizaos/plugin-streaming",
  rtmpSources:  "@elizaos/plugin-streaming",
};
```

**Perfiles de autenticación** — Los perfiles de autenticación que especifican un nombre de proveedor activan la carga del plugin de proveedor correspondiente.

<div id="opting-out">

### Exclusión Voluntaria

</div>

Los plugins individuales pueden deshabilitarse incluso cuando sus variables de entorno están presentes:

```json
{
  "plugins": {
    "entries": {
      "anthropic": { "enabled": false }
    }
  }
}
```

Establecer `plugins.enabled: false` en la configuración deshabilita la auto-habilitación para todos los plugins opcionales.

<div id="dependency-resolution">

## Resolución de Dependencias

</div>

Los plugins se ordenan topológicamente antes de la inicialización. Si el plugin B incluye al plugin A en su arreglo `dependencies`, A siempre se inicializará antes que B.

El campo `priority` proporciona un ordenamiento general independiente de las aristas de dependencia. Los valores de prioridad más bajos se inicializan primero (por defecto: `0`).

<div id="plugin-isolation">

## Aislamiento de Plugins

</div>

Cada plugin recibe:

- Una referencia al `AgentRuntime` compartido (acceso de solo lectura a las capacidades registradas por otros plugins)
- Su propio espacio de nombres de configuración
- Secretos inyectados por el administrador de secretos en el momento de la inicialización

Los plugins no comparten estado mutable directamente — se comunican a través del registro de servicios y el sistema de eventos del runtime.

<div id="module-shape">

## Forma del Módulo

</div>

Cuando un paquete de plugin es importado dinámicamente, `findRuntimePluginExport()` localiza la exportación de Plugin siguiendo este orden de prioridad:

1. `module.default` — exportación por defecto de módulo ES
2. `module.plugin` — exportación nombrada `plugin`
3. El propio `module` — patrón por defecto de CJS
4. Exportaciones nombradas que terminan en `Plugin` o comienzan con `plugin`
5. Otras exportaciones nombradas que coincidan con la forma de la interfaz Plugin
6. Exportaciones mínimas `{ name, description }` para claves nombradas que coincidan con `plugin`

Una exportación de módulo se acepta como Plugin cuando tiene los campos `name` y `description`, además de al menos uno de `services`, `providers`, `actions`, `routes`, `events` (como arreglos) o `init` (como función).

<div id="related">

## Relacionado

</div>

- [Crear un Plugin](/es/plugins/create-a-plugin) — Construir un plugin desde cero
- [Patrones de Plugins](/es/plugins/patterns) — Patrones de implementación comunes
- [Esquemas de Plugins](/es/plugins/schemas) — Referencia completa de esquemas
- [Registro de Plugins](/es/plugins/registry) — Explorar los plugins disponibles
