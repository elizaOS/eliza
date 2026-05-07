---
title: "Services"
sidebarTitle: "Services"
description: "Interface de service, registre de services, liste des services intégrés, cycle de vie des services et modèles de dépendance."
---

Les services sont des composants de longue durée exécutés en arrière-plan et enregistrés auprès d'`AgentRuntime`. Contrairement aux fournisseurs (qui s'exécutent à chaque tour) ou aux actions (qui s'exécutent à la demande), les services démarrent lorsque leur plugin s'initialise et s'exécutent pendant toute la durée de vie de l'agent.

<div id="service-interface">

## Interface de Service

</div>

Depuis `@elizaos/core` :

```typescript
export interface Service {
  serviceType: string;
  initialize(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}
```

| Champ | Type | Description |
|---|---|---|
| `serviceType` | string | Identifiant unique pour ce type de service (par exemple, `"AGENT_SKILLS_SERVICE"`) |
| `initialize()` | function | Appelé une fois lorsque le plugin propriétaire de ce service est initialisé |
| `stop()` | function (optionnel) | Appelé lors de l'arrêt en douceur |

<div id="service-registry">

## Registre de Services

</div>

Les services sont accessibles via le runtime :

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

## Plugins Principaux et leurs Services

</div>

Les plugins principaux sont toujours chargés et chacun fournit un ou plusieurs services :

| Plugin | Type de Service | Description |
|---|---|---|
| `@elizaos/plugin-sql` | Database adapter | Persistance PGLite ou PostgreSQL ; fournit `runtime.adapter` |
| `@elizaos/plugin-local-embedding` | `TEXT_EMBEDDING` handler | Modèle d'embedding GGUF local via node-llama-cpp |
| `@elizaos/core` (capacités avancées) | `FORM` | Formulaires conversationnels structurés — FormService, fournisseur et évaluateur de formulaires (chargé lorsque les capacités avancées sont activées ; pas de plugin npm séparé) |
| `knowledge` | Knowledge service | Indexation et récupération de connaissances RAG |
| `trajectories` | `trajectories` | Capture de trajectoires de débogage et d'entraînement RL |
| `@elizaos/plugin-agent-orchestrator` | Orchestrator service | Coordination et génération de tâches multi-agents |
| `@elizaos/plugin-shell` | Shell service | Exécution de commandes shell avec contrôles de sécurité |
| `@elizaos/plugin-coding-tools` | Services sandbox fichiers/shell | Outils de code natifs (READ, WRITE, EDIT, BASH, GREP, GLOB, …) ; confinement aux racines de workspace |
| `@elizaos/plugin-agent-skills` | `AGENT_SKILLS_SERVICE` | Chargement et exécution du catalogue de compétences |
| `@elizaos/plugin-commands` | Commands service | Gestion des commandes slash (les compétences s'enregistrent automatiquement en tant que /commands) |
| Intégré (`plugin_manager` / `@elizaos/core`) | Plugin manager service | Installation/désinstallation dynamique de plugins au moment de l'exécution |
| `roles` | Roles service | Contrôle d'accès basé sur les rôles (OWNER/ADMIN/NONE) |

<div id="optional-core-services">

## Services Principaux Optionnels

</div>

Ces services sont disponibles mais ne sont pas chargés par défaut — activez-les via le panneau d'administration ou la configuration :

| Plugin | Description |
|---|---|
| `@elizaos/plugin-pdf` | Traitement de documents PDF |
| `@elizaos/plugin-cua` | Agent CUA d'utilisation d'ordinateur (automatisation de sandbox cloud) |
| `@elizaos/plugin-obsidian` | Intégration CLI avec Obsidian vault |
| `@elizaos/plugin-repoprompt` | Intégration CLI avec RepoPrompt |
| `@elizaos/plugin-claude-code-workbench` | Flux de travail compagnons Claude Code |
| `@elizaos/plugin-computeruse` | Automatisation d'utilisation d'ordinateur (spécifique à la plateforme) |
| `@elizaos/plugin-browser` | Automatisation du navigateur (nécessite stagehand-server) |
| `@elizaos/plugin-vision` | Compréhension visuelle (contrôlée par fonctionnalité) |
| `@elizaos/plugin-edge-tts` | Synthèse vocale (Microsoft Edge TTS) |
| `@elizaos/plugin-elevenlabs` | Synthèse vocale ElevenLabs |
| `@elizaos/plugin-cli` | Interface CLI |
| Intégré (`enableSecretsManager` / `ENABLE_SECRETS_MANAGER`) | [Service `SECRETS`](#secrets-secrets-service) — identifiants chiffrés et onboarding (`@elizaos/core`) |
| `relationships` | Graphe de contacts, mémoire relationnelle (importé statiquement, peut être réactivé comme principal) |
| `@elizaos/plugin-x402` | Protocole de micropaiement HTTP x402 |

## Secrets (`SECRETS` service)

Les secrets sont fournis par **`@elizaos/core`** (pas un paquet npm séparé). Activez-les avec `enableSecretsManager: true` ou `ENABLE_SECRETS_MANAGER` sur le personnage ou la configuration ; le runtime enregistre le service `SECRETS` et les actions/fournisseurs associés tôt au démarrage, avant les connecteurs et les autres plugins.

Les secrets sont chiffrés au repos (AES-256-GCM), journalisés de façon contrôlée (noms de clés uniquement) et limités par agent. Utilisez **Agent → Settings → Secrets**, `eliza config path`, la section `secrets` du fichier de configuration, les variables d'environnement au démarrage ou `runtime.getSetting()` depuis les plugins (ordre habituel : secrets en base, `settings.secrets` du personnage, `process.env`, secrets globaux sous `~/.eliza/secrets`).

Les journaux d'audit passent par le service `SECRETS` — la valeur n'est jamais écrite en clair.

<div id="trajectory-logger-service">

## Service de Journalisation des Trajectoires

</div>

Le journaliseur de trajectoires est traité de manière spéciale lors du démarrage. Eliza attend qu'il soit disponible avec un délai d'attente de 3 secondes avant de l'activer :

```typescript
await waitForTrajectoriesService(runtime, "post-init", 3000);
ensureTrajectoryLoggerEnabled(runtime, "post-init");
```

Le service prend en charge les méthodes `isEnabled()` et `setEnabled(enabled: boolean)`. Eliza l'active par défaut après l'initialisation.

<div id="skills-service">

## Service de Compétences

</div>

`@elizaos/plugin-agent-skills` charge et gère le catalogue de compétences. Eliza préchauffe ce service de manière asynchrone après le démarrage :

```typescript
const svc = runtime.getService("AGENT_SKILLS_SERVICE") as {
  getCatalogStats?: () => { loaded: number; total: number; storageType: string };
};
const stats = svc?.getCatalogStats?.();
logger.info(`[eliza] Skills: ${stats.loaded}/${stats.total} loaded`);
```

Les compétences sont découvertes à partir de plusieurs répertoires par ordre de priorité :

```
1. Workspace skills:  <workspaceDir>/skills/
2. Bundled skills:    from @elizaos/skills package
3. Extra dirs:        skills.load.extraDirs
```

Les compétences sont filtrées par les listes `skills.allowBundled` et `skills.denyBundled`. Transmises en tant que paramètres du runtime :

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

`SandboxManager` depuis `src/services/sandbox-manager.ts` fournit une isolation d'exécution de code basée sur Docker lorsque `agents.defaults.sandbox.mode` est `"standard"` ou `"max"` :

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

En mode `"light"`, seul un journal d'audit est créé — sans isolation de conteneur.

<div id="service-lifecycle">

## Cycle de Vie du Service

</div>

```
Plugin enregistré
    ↓
service.initialize(runtime) appelé pendant plugin.init()
    ↓
Service en cours d'exécution (disponible via runtime.getService())
    ↓
Arrêt en douceur : service.stop() appelé
```

<div id="writing-a-service">

## Écrire un Service

</div>

Pour créer un service dans un plugin :

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

## Accéder à un Service depuis un Autre Plugin

</div>

Les services sont accessibles par chaîne de type. Vérifiez toujours si la valeur est null au cas où le service ne serait pas chargé :

```typescript
const myService = runtime.getService("MY_SERVICE") as MyService | null;
if (myService) {
  await myService.doSomething();
}
```

<div id="related-pages">

## Pages Associées

</div>

- [Runtime Principal](/fr/runtime/core) — chargement et enregistrement des plugins
- [Runtime et Cycle de Vie](/fr/agents/runtime-and-lifecycle) — chronologie du démarrage des services
- [Types](/fr/runtime/types) — définitions de types de l'interface Service
