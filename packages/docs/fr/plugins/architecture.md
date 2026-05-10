---
title: "Architecture des Plugins"
sidebarTitle: "Architecture"
description: "Plongée approfondie dans le système de plugins de Eliza — cycle de vie de l'enregistrement, points d'accroche, mécanisme d'activation automatique et résolution des dépendances."
---

Le système de plugins de Eliza repose sur le cœur d'elizaOS. Toute fonctionnalité au-delà du runtime de base — fournisseurs de modèles, connecteurs de plateforme, intégrations DeFi, planification et fonctionnalités personnalisées — est livrée sous forme de plugin.

<div id="system-design">

## Conception du système

</div>

Les plugins sont des modules isolés qui enregistrent des fonctionnalités auprès de l'`AgentRuntime`. Le runtime orchestre le chargement des plugins, la résolution des dépendances, l'initialisation et l'arrêt.

```
AgentRuntime
├── Core Plugins     (toujours chargés)
├── Auto-enabled     (déclenchés par les variables d'env / la config)
├── Character        (spécifiés dans le fichier de personnage)
└── Local            (depuis le répertoire plugins/)
```

La source de vérité pour les plugins toujours chargés se trouve dans `eliza/packages/agent/src/runtime/core-plugins.ts` (dans le sous-module upstream elizaOS, réexportée par `eliza/packages/app-core/src/runtime/core-plugins.ts`) :

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

> **Remarque :** Plusieurs capacités auparavant fournies comme plugins sont désormais intégrées au runtime : experience, form, clipboard, personality (capacités avancées via `advancedCapabilities: true`), trust (via `enableTrust: true`), secrets (via `enableSecretsManager: true`), plugin-manager (via `enablePluginManager: true`), knowledge, relationships et trajectories (natifs). L'agent-orchestrator est optionnel via `ELIZA_AGENT_ORCHESTRATOR` (l'app Eliza l'active par défaut).

<div id="optional-core-plugins">

### Plugins principaux optionnels

</div>

Une liste séparée de plugins principaux optionnels peut être activée depuis le panneau d'administration. Ils ne sont pas chargés par défaut en raison de contraintes de packaging ou de spécification. La liste se trouve dans `eliza/packages/agent/src/runtime/core-plugins.ts` :

```typescript
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-pdf",                   // PDF processing
  "@elizaos/plugin-cua",                   // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian",              // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt",            // RepoPrompt CLI integration
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

Les plugins tels que `@elizaos/plugin-directives`, `@elizaos/plugin-commands`, `@elizaos/plugin-mcp` et `@elizaos/plugin-scheduling` sont commentés dans le code source et pourraient être activés dans de futures versions.

<div id="plugin-hook-points">

## Points d'accroche des plugins

</div>

Un plugin peut enregistrer n'importe quelle combinaison des points d'accroche suivants :

| Point d'accroche | Type | Objectif |
|------|------|---------|
| `actions` | `Action[]` | Ce que l'agent peut faire ; le LLM sélectionne les actions dans cette liste |
| `providers` | `Provider[]` | Contexte injecté dans le prompt avant chaque appel LLM |
| `evaluators` | `Evaluator[]` | Évaluation post-réponse ; peut déclencher des actions de suivi |
| `services` | `ServiceClass[]` | Processus d'arrière-plan de longue durée |
| `routes` | `Route[]` | Points de terminaison HTTP exposés par le serveur API de l'agent |
| `events` | `Record<EventName, Handler[]>` | Callbacks pour les événements du runtime |
| `models` | `Record<ModelType, Handler>` | Gestionnaires d'inférence de modèles personnalisés |

<div id="registration-lifecycle">

## Cycle de vie de l'enregistrement

</div>

```
1. Resolve      — Le package du plugin est localisé (npm, local, workspace)
2. Import       — Le module est importé dynamiquement et sa structure est validée
3. Sort         — Les plugins sont triés par dépendances et champ de priorité
4. Init         — plugin.init(config, runtime) est appelé
5. Register     — actions, providers, services, routes, events sont enregistrés
6. Active       — Le plugin répond aux messages et événements
7. Shutdown     — plugin.cleanup() / service.stop() appelé à l'arrêt
```

<div id="plugin-interface">

### Interface Plugin

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

## Mécanisme d'activation automatique

</div>

Les plugins sont automatiquement activés lorsque leur configuration requise est détectée. Cette logique se trouve dans `eliza/packages/agent/src/config/plugin-auto-enable.ts` (étendue par le `plugin-auto-enable.ts` de Eliza pour les connecteurs comme WeChat) et s'exécute avant l'initialisation du runtime.

<div id="trigger-sources">

### Sources de déclenchement

</div>

**Clés API des variables d'environnement** — La map `AUTH_PROVIDER_PLUGINS` associe les variables d'environnement aux noms de packages de plugins :

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

};
```

**Configuration des connecteurs** — Les blocs de connecteurs avec un champ `botToken`, `token` ou `apiKey` activent automatiquement le plugin de connecteur correspondant :

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

> **Remarque :** Le package amont `packages/agent` définit tous les connecteurs `@elizaos/*`. Le `packages/app-core` de Eliza étend cette map avec l'entrée `wechat` pointant vers `@elizaos/plugin-wechat`.

**Drapeaux de fonctionnalités** — La section `features` de `eliza.json` active automatiquement les plugins de fonctionnalités. Une fonctionnalité peut être activée avec `features.<name>: true` ou `features.<name>.enabled: true` :

```json
{
  "features": {
    "browser": true,
    "imageGen": true,
    "tts": { "enabled": true }
  }
}
```

La map complète `FEATURE_PLUGINS` :

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
};
```

> **Remarque :** `personality`, `experience` et `form` ne sont plus des entrées de paquets distinctes dans la carte des feature flags — ce sont des capacités avancées intégrées à `@elizaos/core`, activées via `advancedCapabilities: true` dans les réglages du personnage.

**Destinations de streaming** — La section `streaming` de la configuration active automatiquement les plugins de streaming pour les plateformes vidéo en direct :

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

**Profils d'authentification** — Les profils d'authentification spécifiant un nom de fournisseur déclenchent le chargement du plugin fournisseur correspondant.

<div id="opting-out">

### Désactivation

</div>

Des plugins individuels peuvent être désactivés même lorsque leurs variables d'environnement sont présentes :

```json
{
  "plugins": {
    "entries": {
      "anthropic": { "enabled": false }
    }
  }
}
```

Définir `plugins.enabled: false` dans la configuration désactive l'activation automatique pour tous les plugins optionnels.

<div id="dependency-resolution">

## Résolution des dépendances

</div>

Les plugins sont triés topologiquement avant l'initialisation. Si le plugin B liste le plugin A dans son tableau `dependencies`, A sera toujours initialisé avant B.

Le champ `priority` fournit un ordonnancement grossier indépendant des liens de dépendance. Les valeurs de priorité plus basses s'initialisent en premier (par défaut : `0`).

<div id="plugin-isolation">

## Isolation des plugins

</div>

Chaque plugin reçoit :

- Une référence au `AgentRuntime` partagé (accès en lecture seule aux fonctionnalités enregistrées par les autres plugins)
- Son propre espace de noms de configuration
- Les secrets injectés par le gestionnaire de secrets au moment de l'initialisation

Les plugins ne partagent pas directement d'état mutable — ils communiquent via le registre de services et le système d'événements du runtime.

<div id="module-shape">

## Structure du module

</div>

Lorsqu'un package de plugin est importé dynamiquement, `findRuntimePluginExport()` localise l'export Plugin en utilisant cet ordre de priorité :

1. `module.default` — export par défaut d'un module ES
2. `module.plugin` — export nommé `plugin`
3. `module` lui-même — pattern par défaut CJS
4. Exports nommés se terminant par `Plugin` ou commençant par `plugin`
5. Autres exports nommés correspondant à la structure de l'interface Plugin
6. Exports minimaux `{ name, description }` pour les clés nommées correspondant à `plugin`

Un export de module est accepté comme Plugin lorsqu'il possède à la fois les champs `name` et `description`, ainsi qu'au moins un des champs `services`, `providers`, `actions`, `routes`, `events` (en tant que tableaux), ou `init` (en tant que fonction).

<div id="related">

## Voir aussi

</div>

- [Créer un Plugin](/fr/plugins/create-a-plugin) — Construire un plugin à partir de zéro
- [Patterns de Plugins](/fr/plugins/patterns) — Patterns d'implémentation courants
- [Schémas de Plugins](/fr/plugins/schemas) — Référence complète des schémas
- [Registre de Plugins](/fr/plugins/registry) — Parcourir les plugins disponibles
