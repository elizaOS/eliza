---
title: "Plugin Slack"
sidebarTitle: "Slack"
description: "Connecteur Slack pour Eliza — bot d'espace de travail, surveillance des canaux, commandes slash et composants interactifs."
---

Le plugin Slack connecte les agents Eliza aux espaces de travail Slack en tant qu'application bot, gérant les messages dans les canaux, les messages directs et les fils de discussion avec prise en charge des commandes slash et des composants interactifs.

**Package:** `@elizaos/plugin-slack`

<div id="installation">
## Installation
</div>

```bash
eliza plugins install @elizaos/plugin-slack
```

<div id="setup">
## Configuration
</div>

<div id="1-create-a-slack-app">
### 1. Créer une application Slack
</div>

1. Allez sur [api.slack.com/apps](https://api.slack.com/apps)
2. Cliquez sur **Create New App → From scratch**
3. Nommez l'application et sélectionnez votre espace de travail

<div id="2-configure-bot-permissions">
### 2. Configurer les permissions du bot
</div>

Naviguez vers **OAuth & Permissions → Scopes → Bot Token Scopes** et ajoutez :

| Scope | Objectif |
|-------|----------|
| `app_mentions:read` | Recevoir les @mentions |
| `channels:history` | Lire les messages du canal |
| `channels:read` | Lister les canaux |
| `chat:write` | Publier des messages |
| `groups:history` | Lire les messages des canaux privés |
| `im:history` | Lire l'historique des messages directs |
| `im:read` | Accéder aux informations des messages directs |
| `im:write` | Envoyer des messages directs |
| `mpim:history` | Lire l'historique des messages directs de groupe |
| `reactions:write` | Ajouter des réactions |
| `users:read` | Rechercher les informations utilisateur |

<div id="3-enable-socket-mode-recommended-for-development">
### 3. Activer le Socket Mode (Recommandé pour le développement)
</div>

Naviguez vers **Socket Mode** et activez-le. Générez un jeton de niveau application avec le scope `connections:write`.

<div id="4-enable-event-subscriptions">
### 4. Activer les abonnements aux événements
</div>

Naviguez vers **Event Subscriptions** et abonnez-vous aux événements du bot :

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

<div id="5-install-to-workspace">
### 5. Installer dans l'espace de travail
</div>

Naviguez vers **OAuth & Permissions** et cliquez sur **Install to Workspace**. Copiez le **Bot User OAuth Token** (`xoxb-...`).

<div id="6-configure-eliza">
### 6. Configurer Eliza
</div>

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="configuration">
## Configuration
</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `botToken` | Oui | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | Non | Jeton de niveau application pour le Socket Mode (`xapp-...`) |
| `signingSecret` | Non | Secret de signature pour la vérification du webhook |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |
| `allowedChannels` | Non | Tableau d'identifiants de canaux où répondre |

<div id="features">
## Fonctionnalités
</div>

- **Commandes slash** — Enregistrer et répondre aux `/commands`
- **@mentions** — Répond lorsqu'il est mentionné dans les canaux
- **Messages directs** — Prise en charge complète des conversations privées
- **Fils de discussion** — Participe aux réponses en fil de discussion
- **Réactions** — Ajoute des réactions emoji aux messages
- **Socket Mode** — Livraison d'événements en temps réel sans URL publique
- **Mode webhook** — Prise en charge du point de terminaison webhook en production
- **Composants interactifs** — Boutons et modales Block Kit

<div id="message-flow">
## Flux de messages
</div>

```
Événement Slack (via Socket Mode ou webhook)
       ↓
Le plugin valide la signature de l'événement
       ↓
Détermine le contexte de réponse :
  - app_mention → répondre dans le fil du canal
  - message.im → répondre en message direct
       ↓
AgentRuntime traite le message
       ↓
Réponse publiée dans le canal/message direct Slack
```

<div id="auto-enable">
## Activation automatique
</div>

Le plugin s'active automatiquement lorsque `connectors.slack.botToken` est défini.

<div id="thread-behavior">
## Comportement des fils de discussion
</div>

Par défaut, les réponses sont publiées sous forme de réponses en fil de discussion pour garder les canaux propres. Pour publier des réponses de premier niveau :

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "replyInThread": false
    }
  }
}
```

<div id="related">
## Associé
</div>

- [Plugin Discord](/plugin-registry/platform/discord) — Intégration du bot Discord
- [Plugin Telegram](/plugin-registry/platform/telegram) — Intégration du bot Telegram
- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
