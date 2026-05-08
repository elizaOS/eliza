---
title: "Runtime principal"
sidebarTitle: "Core"
description: "Classe AgentRuntime, paramètres du constructeur, enregistrement des plugins et cascade de configuration Eliza."
---

La classe `AgentRuntime` de `@elizaos/core` est l'objet central qui gère l'enregistrement des plugins, le traitement des messages, l'assemblage du contexte des fournisseurs et le cycle de vie des services. Eliza l'enveloppe avec une logique d'amorçage supplémentaire dans `src/runtime/eliza.ts`.

<div id="agentruntime-constructor">
## Constructeur AgentRuntime
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
### Paramètres du constructeur
</div>

| Paramètre | Type | Description |
|---|---|---|
| `character` | `Character` | L'identité, la personnalité et les secrets de l'agent. Construit par `buildCharacterFromConfig()`. |
| `actionPlanning` | `boolean` | Active le sous-système de planification d'actions. Eliza le définit à `true`. |
| `plugins` | `Plugin[]` | Tableau ordonné de plugins. Le plugin Eliza vient en premier, puis les plugins résolus. |
| `logLevel` | `string` | Verbosité des logs : `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`. Résolu depuis `config.logging.level`. |
| `sandboxMode` | `boolean` | Active le remplacement de tokens sandbox pour la journalisation d'audit. Inclus dans le constructeur uniquement quand `isSandboxActive` est vrai (c.-à-d., `agents.defaults.sandbox.mode != "off"`). Quand le sandbox est désactivé, ce paramètre n'est pas passé. |
| `sandboxAuditHandler` | `function` | Callback pour les événements d'audit fetch du sandbox. Reçoit `{ direction, url, tokenIds }`. |
| `settings` | `Record<string, string>` | Paramètres du runtime passés aux plugins via `runtime.getSetting()`. |

<div id="key-settings">
## Paramètres clés
</div>

| Clé du paramètre | Source | Description |
|---|---|---|
| `VALIDATION_LEVEL` | Codé en dur | Défini à `"fast"` — contrôle la profondeur de validation d'elizaOS |
| `MODEL_PROVIDER` | `agents.defaults.model.primary` | Sélection du modèle primaire (par ex., `"anthropic/claude-sonnet-4.6"`) |
| `BUNDLED_SKILLS_DIRS` | package `@elizaos/skills` | Chemin absolu vers le répertoire des compétences incluses |
| `WORKSPACE_SKILLS_DIR` | chemin du workspace + `/skills` | Répertoire de surcharge des compétences par agent |
| `EXTRA_SKILLS_DIRS` | `skills.load.extraDirs` | Répertoires de compétences supplémentaires depuis la configuration |
| `SKILLS_ALLOWLIST` | `skills.allowBundled` | Liste séparée par des virgules des compétences incluses autorisées |
| `SKILLS_DENYLIST` | `skills.denyBundled` | Liste séparée par des virgules des compétences incluses refusées |
| `DISABLE_IMAGE_DESCRIPTION` | `features.vision == false` | Empêche la description d'images même quand le plugin cloud est chargé |

<div id="plugin-registration">
## Enregistrement des plugins
</div>

Eliza enregistre les plugins en deux phases :

<div id="phase-1-pre-registration-sequential">
### Phase 1 : Pré-enregistrement (séquentiel)
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
**Récupération du plugin SQL** : `registerSqlPluginWithRecovery()` enveloppe l'enregistrement du plugin SQL dans un try/catch. Si l'enregistrement initial échoue en raison d'un état PGLite corrompu, le wrapper supprime le répertoire de données PGLite, enregistre un avertissement et réessaie l'enregistrement depuis le début. Cela empêche l'agent d'être bloqué de façon permanente après qu'un crash ait corrompu la base de données locale.
</Note>

<div id="phase-2-full-initialization-parallel">
### Phase 2 : Initialisation complète (parallèle)
</div>

```typescript
// All remaining plugins initialize in parallel
await runtime.initialize();
```

`runtime.initialize()` appelle `init()` sur chaque plugin enregistré et démarre tous les services enregistrés.

<div id="plugin-export-detection">
## Détection d'exportation de plugin
</div>

`findRuntimePluginExport()` dans `src/runtime/eliza.ts` localise l'exportation Plugin d'un module importé dynamiquement en utilisant un ordre de priorité :

```
1. module.default   (exportation par défaut du module ES)
2. module.plugin    (exportation nommée "plugin")
3. module itself    (pattern par défaut CJS)
4. Named exports ending in "Plugin" or starting with "plugin"
5. Other named exports that match Plugin shape
6. Minimal { name, description } exports for named keys matching "plugin"
```

<div id="plugin-shape-validation">
## Validation de la forme du plugin
</div>

Une exportation de module est acceptée comme Plugin lorsqu'elle possède les champs `name` et `description` plus au moins l'un de :

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

`collectPluginNames(config)` produit l'ensemble complet des noms de packages de plugins à charger :

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
**Exclusion du plugin Eliza Cloud** : Lorsque Eliza Cloud est effectivement activé (la clé API cloud est définie et le plugin cloud est chargé), les plugins de fournisseurs d'IA directs (par ex., `@elizaos/plugin-anthropic`, `@elizaos/plugin-openai`) sont retirés de l'ensemble de chargement. Le plugin cloud proxy les requêtes de modèles via Eliza Cloud, donc charger des plugins de fournisseurs individuels serait redondant et pourrait causer des conflits de routage.
</Note>

<div id="channel-to-plugin-mapping">
## Mappage canal vers plugin
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
## Mappage fournisseur vers plugin
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
## Limites d'erreur
</div>

Chaque `init()` et `providers` d'un plugin est enveloppé avec des limites d'erreur via `wrapPluginWithErrorBoundary()`. Un crash dans `init()` enregistre l'erreur et met le plugin en mode dégradé. Un crash dans le `get()` d'un fournisseur retourne un texte marqueur d'erreur au lieu de lancer une exception :

```typescript
return {
  text: `[Provider ${provider.name} error: ${msg}]`,
  data: { _providerError: true },
};
```

<div id="method-bindings">
## Liaisons de méthodes
</div>

`installRuntimeMethodBindings()` lie certaines méthodes du runtime à l'instance du runtime pour empêcher la perte du contexte `this` lorsque la méthode est stockée et invoquée par des plugins :

```typescript
runtime.getConversationLength = runtime.getConversationLength.bind(runtime);
```

<div id="configuration-cascade">
## Cascade de configuration
</div>

Les valeurs de configuration cascadent depuis plusieurs sources dans cet ordre de priorité :

```
process.env (priorité la plus haute)
  ↓
eliza.json (fichier de configuration)
  ↓
Objet settings d'AgentRuntime
  ↓
Valeurs par défaut du plugin (priorité la plus basse)
```

<div id="related-pages">
## Pages connexes
</div>

- [Runtime et cycle de vie](/fr/agents/runtime-and-lifecycle) — la séquence complète de démarrage
- [Services](/fr/runtime/services) — enregistrement et cycle de vie des services
- [Fournisseurs](/fr/runtime/providers) — interface des fournisseurs et injection de contexte
- [Modèles](/fr/runtime/models) — sélection et configuration des fournisseurs de modèles
