---
title: Vue d'ensemble des plugins
sidebarTitle: Vue d'ensemble
description: Le système de plugins de Eliza fournit des capacités modulaires — fournisseurs de modèles, connecteurs de plateformes, intégrations DeFi et fonctionnalités personnalisées.
---

Les plugins sont le mécanisme d'extension principal d'elizaOS. Chaque capacité au-delà du runtime principal — des fournisseurs de LLM aux interactions blockchain — est livrée sous forme de plugin.

<div id="what-is-a-plugin">

## Qu'est-ce qu'un Plugin ?

</div>

Un plugin est un module autonome qui enregistre un ou plusieurs des éléments suivants :

- **Actions** — Ce que l'agent peut faire (par exemple, envoyer un tweet, échanger des tokens)
- **Providers** — Contexte injecté dans le prompt de l'agent (par exemple, solde du portefeuille, heure)
- **Evaluators** — Logique de post-traitement exécutée après chaque réponse
- **Services** — Processus en arrière-plan de longue durée (par exemple, tâches cron, écouteurs d'événements)

<div id="plugin-categories">

## Catégories de Plugins

</div>

<CardGroup cols={2}>

<Card title="Plugins principaux" icon="cube" href="/fr/plugin-registry/documents">
  Plugins essentiels livrés avec chaque installation de Eliza — knowledge, database, form, cron, shell, agent-skills, trajectories et agent-orchestrator.
</Card>

<Card title="Fournisseurs de modèles" icon="brain" href="/fr/plugin-registry/llm/openai">
  Intégrations LLM disponibles dans le registre : OpenAI, Anthropic, Google Gemini, Groq, Ollama, OpenRouter, xAI, Vercel AI Gateway et Eliza Cloud. Fournisseurs supplémentaires (DeepSeek, Mistral, Cohere, etc.) accessibles via OpenRouter.
</Card>

<Card title="Connecteurs de plateformes" icon="plug" href="/fr/plugin-registry/platform/discord">
  28 connecteurs de plateformes. 18 s'activent automatiquement via la configuration (Discord, Telegram, Twitter, Slack, WhatsApp, Signal, iMessage, Blooio, MS Teams, Google Chat, Mattermost, Farcaster, Twitch, WeChat, Feishu, Matrix, Nostr, Lens). 10 autres sont installables depuis le registre (BlueBubbles, Bluesky, Instagram, LINE, Zalo, Twilio, GitHub, Gmail Watch, Nextcloud Talk, Tlon).
</Card>

<Card title="DeFi et Blockchain" icon="wallet" href="/fr/plugin-registry/defi/evm">
  Interactions on-chain pour les chaînes EVM et Solana — transferts de tokens, swaps et protocoles DeFi.
</Card>

<Card title="Plugins de fonctionnalités" icon="wand-magic-sparkles" href="/fr/plugin-registry/browser">
  Capacités étendues — contrôle du navigateur, génération d'images, synthèse vocale, reconnaissance vocale, utilisation d'ordinateur, planification cron, vision, shell, webhooks, génération de médias FAL, musique Suno, diagnostics OpenTelemetry, paiements x402, synchronisation de coffres Obsidian, Gmail Watch, réglage de personnalité, suivi d'expérience, compétences d'agent, atelier Claude Code, RepoPrompt et plus encore.
</Card>

</CardGroup>

<div id="how-plugins-load">

## Comment les Plugins se chargent

</div>

Les plugins sont chargés lors de l'initialisation du runtime dans cet ordre :

1. **Plugin Eliza** — Le plugin passerelle (`createElizaPlugin()`) fournissant le contexte du workspace, les clés de session, les emotes, les actions personnalisées et les actions de cycle de vie. Toujours en première position dans le tableau de plugins.
2. **Plugins pré-enregistrés** — `@elizaos/plugin-sql` et `@elizaos/plugin-local-embedding` sont pré-enregistrés avant `runtime.initialize()` pour éviter les conditions de concurrence.
3. **Plugins principaux** — Toujours chargés : `sql`, `local-embedding`, `form`, `knowledge`, `trajectories`, `agent-orchestrator`, `cron`, `shell`, `agent-skills` (voir `packages/agent/src/runtime/core-plugins.ts`). Des plugins supplémentaires comme `pdf`, `cua`, `browser`, `computeruse`, `obsidian`, `code`, `repoprompt`, `claude-code-workbench`, `vision`, `cli`, `edge-tts`, `elevenlabs`, `discord`, `telegram` et `twitch` sont optionnels et chargés lorsque leurs feature flags ou variables d'environnement sont configurés.
4. **Plugins auto-activés** — Les plugins de connecteurs, fournisseurs, fonctionnalités, streaming, abonnement, hooks (webhooks + Gmail Watch) et génération de médias sont auto-activés en fonction de la configuration et des variables d'environnement (voir [Architecture](/fr/plugins/architecture) pour les cartes complètes).
5. **Plugins éjectés** — Surcharges locales découvertes depuis `~/.eliza/plugins/ejected/`. Lorsqu'une copie éjectée existe, elle a la priorité sur la version publiée sur npm.
6. **Plugins installés par l'utilisateur** — Suivis dans `plugins.installs` dans `eliza.json`. Collectés avant les plugins drop-in ; tout nom de plugin déjà présent ici a la priorité.
7. **Plugins personnalisés/drop-in** — Scannés depuis `~/.eliza/plugins/custom/` et tout chemin supplémentaire dans `plugins.load.paths`. Les plugins dont les noms existent déjà dans `plugins.installs` sont ignorés (règle de priorité de `mergeDropInPlugins`).

```json
// eliza.json plugin configuration
{
  "plugins": {
    "allow": ["@elizaos/plugin-openai", "discord"],
    "entries": {
      "openai": { "enabled": true }
    }
  },
  "connectors": {
    "discord": { "token": "..." }
  }
}
```

<div id="plugin-lifecycle">

## Cycle de vie du Plugin

</div>

```
Install → Register → Initialize → Active → Shutdown
```

1. **Install** — Le package du plugin est résolu (npm ou local)
2. **Register** — Les actions, fournisseurs, évaluateurs et services sont enregistrés auprès du runtime
3. **Initialize** — `init()` est appelé avec le contexte du runtime
4. **Active** — Le plugin traite les événements et fournit des capacités
5. **Shutdown** — `cleanup()` est appelé à l'arrêt du runtime

<div id="managing-plugins">

## Gestion des Plugins

</div>

<div id="install-from-registry">

### Installer depuis le Registre

</div>

```bash
eliza plugins install @elizaos/plugin-openai
```

<div id="list-installed-plugins">

### Lister les Plugins installés

</div>

```bash
eliza plugins list
```

<div id="enable-disable">

### Activer/Désactiver

</div>

Activez ou désactivez un plugin en définissant son flag `enabled` dans `eliza.json` :

```json
{
  "plugins": {
    "entries": {
      "plugin-name": { "enabled": false }
    }
  }
}
```

Ou modifiez directement le fichier de configuration (`eliza config path` affiche l'emplacement du fichier) :

```bash
$EDITOR "$(eliza config path)"
```

<div id="eject-copy-to-local">

### Éjecter (Copier en local)

</div>

Éjectez un plugin via le chat de l'agent pour cloner son code source et l'éditer localement :

```
eject the telegram plugin so I can edit its source
```

Consultez [Éjecter un Plugin](/fr/plugins/plugin-eject) pour le flux complet éjecter/synchroniser/réinjecter.

<div id="related">

## Associé

</div>

- [Architecture des Plugins](/fr/plugins/architecture) — Analyse approfondie du système de plugins
- [Créer un Plugin](/fr/plugins/create-a-plugin) — Tutoriel étape par étape
- [Développement de Plugins](/fr/plugins/development) — Guide de développement et API
- [Registre des Plugins](/fr/plugins/registry) — Parcourir les plugins disponibles
