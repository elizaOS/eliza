---
title: "Servicios"
sidebarTitle: "Servicios"
description: "Interfaz de servicio, registro de servicios, lista de servicios integrados, ciclo de vida del servicio y patrones de dependencia."
---

Los servicios son componentes de larga ejecución en segundo plano registrados con `AgentRuntime`. A diferencia de los proveedores (que se ejecutan en cada turno) o las acciones (que se ejecutan bajo demanda), los servicios se inician cuando su plugin se inicializa y se ejecutan durante toda la vida del agente.

<div id="service-interface">

## Interfaz de Servicio

</div>

Desde `@elizaos/core`:

```typescript
export interface Service {
  serviceType: string;
  initialize(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `serviceType` | string | Identificador único para este tipo de servicio (por ejemplo, `"AGENT_SKILLS_SERVICE"`) |
| `initialize()` | function | Se llama una vez cuando el plugin propietario de este servicio se inicializa |
| `stop()` | function (opcional) | Se llama durante el apagado ordenado |

<div id="service-registry">

## Registro de Servicios

</div>

Los servicios son accesibles a través del runtime:

```typescript
// Get a service by type string
const service = runtime.getService("AGENT_SKILLS_SERVICE");

// Get all services of a type (returns array for multi-instance services)
const services = runtime.getServicesByType("trajectories");

// Wait for a service to finish loading
const svcPromise = runtime.getServiceLoadPromise("AGENT_SKILLS_SERVICE");

// Check registration status
const status = runtime.getServiceRegistrationStatus("trajectories");
// Returns: "pending" | "registering" | "registered" | "failed" | "unknown"
```

<div id="core-plugins-and-their-services">

## Plugins Principales y sus Servicios

</div>

Los plugins principales siempre se cargan y cada uno proporciona uno o más servicios:

| Plugin | Tipo de Servicio | Descripción |
|---|---|---|
| `@elizaos/plugin-sql` | Database adapter | Persistencia con PGLite o PostgreSQL; proporciona `runtime.adapter` |
| `@elizaos/plugin-local-embedding` | `TEXT_EMBEDDING` handler | Modelo de embedding GGUF local mediante node-llama-cpp |
| `@elizaos/core` (capacidades avanzadas) | `FORM` | Formularios conversacionales estructurados — FormService, proveedor y evaluador de formularios (se carga con capacidades avanzadas activadas; sin plugin npm aparte) |
| `knowledge` | Knowledge service | Indexación y recuperación de conocimiento RAG |
| `trajectories` | `trajectories` | Captura de trayectorias de depuración y entrenamiento RL |
| `@elizaos/plugin-agent-orchestrator` | Orchestrator service | Coordinación y generación de tareas multi-agente |
| `@elizaos/plugin-shell` | Shell service | Ejecución de comandos de shell con controles de seguridad |
| `@elizaos/plugin-coding-tools` | Servicios sandbox de archivos/shell | Herramientas de código nativas (READ, WRITE, EDIT, BASH, GREP, GLOB, …); rutas limitadas a raíces de workspace |
| `@elizaos/plugin-agent-skills` | `AGENT_SKILLS_SERVICE` | Carga y ejecución del catálogo de habilidades |
| `@elizaos/plugin-commands` | Commands service | Manejo de comandos slash (las habilidades se registran automáticamente como /commands) |
| Integrado (`plugin_manager` / `@elizaos/core`) | Plugin manager service | Instalación/desinstalación dinámica de plugins en tiempo de ejecución |
| `roles` | Roles service | Control de acceso basado en roles (OWNER/ADMIN/NONE) |

<div id="optional-core-services">

## Servicios Principales Opcionales

</div>

Estos servicios están disponibles pero no se cargan por defecto — se habilitan a través del panel de administración o configuración:

| Plugin | Descripción |
|---|---|
| `@elizaos/plugin-pdf` | Procesamiento de documentos PDF |
| `@elizaos/plugin-cua` | Agente CUA de uso de computadora (automatización de sandbox en la nube) |
| `@elizaos/plugin-obsidian` | Integración CLI con Obsidian vault |
| `@elizaos/plugin-repoprompt` | Integración CLI con RepoPrompt |
| `@elizaos/plugin-computeruse` | Automatización de uso de computadora (específico de plataforma) |
| `@elizaos/plugin-browser` | Automatización de navegador (requiere stagehand-server) |
| `@elizaos/plugin-vision` | Comprensión visual (con control de funcionalidad) |
| `@elizaos/plugin-edge-tts` | Texto a voz (Microsoft Edge TTS) |
| `@elizaos/plugin-elevenlabs` | Texto a voz de ElevenLabs |
| `@elizaos/plugin-cli` | Interfaz CLI |
| Integrado (`enableSecretsManager` / `ENABLE_SECRETS_MANAGER`) | [Servicio `SECRETS`](#secrets-secrets-service) — almacenamiento cifrado de credenciales y onboarding (`@elizaos/core`) |
| `relationships` | Grafo de contactos, memoria de relaciones (importado estáticamente, puede rehabilitarse como principal) |
| `@elizaos/plugin-x402` | Protocolo de micropagos HTTP x402 |

## Secrets (`SECRETS`)

Los secretos los gestiona **`@elizaos/core`** (no como paquete npm independiente). Actívalo con `enableSecretsManager: true` o `ENABLE_SECRETS_MANAGER` en el personaje o la configuración; el runtime registra el servicio `SECRETS` y las acciones/proveedores asociados al inicio, antes de otros plugins.

Los secretos se cifran en reposo (AES-256-GCM), quedan auditados (solo nombres de clave, nunca valores) y tienen alcance por agente. Usa **Agente → Settings → Secrets**, `eliza config path`, la sección `secrets` del archivo de configuración, variables de entorno al arrancar u `runtime.getSetting()` desde plugins (prioridad habitual: valores en base de datos, `settings.secrets` del character, `process.env`, secretos globales bajo `~/.eliza/secrets`).

En los registros de auditoría sólo aparecen nombres de clave; nunca se escribe el valor en claro.

<div id="trajectory-logger-service">

## Servicio de Registro de Trayectorias

</div>

El registrador de trayectorias se trata de forma especial durante el arranque. Eliza espera a que esté disponible con un tiempo de espera de 3 segundos antes de habilitarlo:

```typescript
await waitForTrajectoriesService(runtime, "post-init", 3000);
ensureTrajectoryLoggerEnabled(runtime, "post-init");
```

El servicio soporta los métodos `isEnabled()` y `setEnabled(enabled: boolean)`. Eliza lo habilita por defecto después de la inicialización.

<div id="skills-service">

## Servicio de Habilidades

</div>

`@elizaos/plugin-agent-skills` carga y gestiona el catálogo de habilidades. Eliza precalienta este servicio de forma asíncrona después del arranque:

```typescript
const svc = runtime.getService("AGENT_SKILLS_SERVICE") as {
  getCatalogStats?: () => { loaded: number; total: number; storageType: string };
};
const stats = svc?.getCatalogStats?.();
logger.info(`[eliza] Skills: ${stats.loaded}/${stats.total} loaded`);
```

Las habilidades se descubren desde múltiples directorios en orden de precedencia:

```
1. Workspace skills:  <workspaceDir>/skills/
2. Bundled skills:    from @elizaos/skills package
3. Extra dirs:        skills.load.extraDirs
```

Las habilidades se filtran mediante las listas `skills.allowBundled` y `skills.denyBundled`. Se reenvían como configuraciones del runtime:

```
BUNDLED_SKILLS_DIRS = <path from @elizaos/skills>
WORKSPACE_SKILLS_DIR = <workspaceDir>/skills
EXTRA_SKILLS_DIRS = <comma-separated extra dirs>
SKILLS_ALLOWLIST = <comma-separated allowed skill names>
SKILLS_DENYLIST = <comma-separated denied skill names>
```

<div id="sandbox-manager">

## Sandbox Manager

</div>

`SandboxManager` desde `src/services/sandbox-manager.ts` proporciona aislamiento de ejecución de código basado en Docker cuando `agents.defaults.sandbox.mode` es `"standard"` o `"max"`:

```typescript
const sandboxManager = new SandboxManager({
  mode: "standard",
  image: dockerSettings?.image ?? undefined,  // no default image — must be configured
  browser: dockerSettings?.browser ?? undefined,
  containerPrefix: "eliza-sandbox-",
  network: "bridge",
  memory: "512m",
  cpus: 0.5,
  workspaceRoot: workspaceDir,
});

await sandboxManager.start();
```

En modo `"light"`, solo se crea un registro de auditoría — sin aislamiento de contenedor.

<div id="service-lifecycle">

## Ciclo de Vida del Servicio

</div>

```
Plugin registrado
    ↓
service.initialize(runtime) llamado durante plugin.init()
    ↓
Servicio en ejecución (disponible a través de runtime.getService())
    ↓
Apagado ordenado: service.stop() llamado
```

<div id="writing-a-service">

## Escribir un Servicio

</div>

Para crear un servicio en un plugin:

```typescript
import type { IAgentRuntime, Service } from "@elizaos/core";

class MyService implements Service {
  serviceType = "MY_SERVICE";
  private runtime!: IAgentRuntime;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    // Start background work
    this.startPolling();
  }

  async stop(): Promise<void> {
    // Clean up resources
    this.stopPolling();
  }
}

// In the plugin:
export default {
  name: "my-plugin",
  description: "...",
  services: [new MyService()],
};
```

<div id="accessing-a-service-from-another-plugin">

## Acceder a un Servicio desde Otro Plugin

</div>

Los servicios se acceden mediante cadena de tipo. Siempre verifica si es null en caso de que el servicio no esté cargado:

```typescript
const myService = runtime.getService("MY_SERVICE") as MyService | null;
if (myService) {
  await myService.doSomething();
}
```

<div id="related-pages">

## Páginas Relacionadas

</div>

- [Runtime Principal](/es/runtime/core) — carga y registro de plugins
- [Runtime y Ciclo de Vida](/es/agents/runtime-and-lifecycle) — tiempos de arranque de servicios
- [Tipos](/es/runtime/types) — definiciones de tipos de la interfaz Service
