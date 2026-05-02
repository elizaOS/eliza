---
title: Connecteur Slack
sidebarTitle: Slack
description: Connectez votre agent aux espaces de travail Slack en utilisant le package @elizaos/plugin-slack.
---

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Slack est un plugin externe elizaOS qui relie votre agent aux espaces de travail Slack. Il prend en charge deux modes de transport (Socket Mode et webhooks HTTP), la configuration par canal, les politiques de messages directs, les commandes slash, le support multi-comptes et les permissions d'actions granulaires. Le connecteur est automatiquement activé par le runtime lorsqu'un token valide est détecté dans la configuration de votre connecteur.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-slack` |
| Clé de configuration | `connectors.slack` |
| Déclencheur d'activation automatique | `botToken`, `token` ou `apiKey` est véridique dans la configuration du connecteur |

<div id="minimal-configuration">

## Configuration minimale

</div>

Dans `~/.eliza/eliza.json` :

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token"
    }
  }
}
```

<div id="disabling">

## Désactivation

</div>

Pour désactiver explicitement le connecteur même lorsqu'un token est présent :

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## Mécanisme d'activation automatique

</div>

Le module `plugin-auto-enable.ts` vérifie `connectors.slack` dans votre configuration. Si l'un des champs `botToken`, `token` ou `apiKey` est véridique (et que `enabled` n'est pas explicitement `false`), le runtime charge automatiquement `@elizaos/plugin-slack`.

Aucune variable d'environnement n'est requise pour déclencher l'activation automatique — elle est entièrement pilotée par l'objet de configuration du connecteur.

<div id="environment-variables">

## Variables d'environnement

</div>

Lorsque le connecteur est chargé, le runtime envoie les secrets suivants de votre configuration dans `process.env` pour que le plugin les consomme :

| Variable | Source | Description |
|----------|--------|-------------|
| `SLACK_BOT_TOKEN` | `botToken` | Token du bot (`xoxb-...`) |
| `SLACK_APP_TOKEN` | `appToken` | Token au niveau application (`xapp-...`) pour Socket Mode |
| `SLACK_USER_TOKEN` | `userToken` | Token utilisateur (`xoxp-...`) pour les actions à portée utilisateur |

<div id="transport-modes">

## Modes de transport

</div>

Slack prend en charge deux modes de transport :

<div id="socket-mode-default">

### Socket Mode (par défaut)

</div>

Utilise WebSocket via l'API Socket Mode de Slack. Nécessite un token au niveau application (`xapp-...`).

```json
{
  "connectors": {
    "slack": {
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="http-mode">

### Mode HTTP

</div>

Reçoit les événements via des webhooks HTTP. Nécessite un secret de signature pour la vérification des requêtes.

```json
{
  "connectors": {
    "slack": {
      "mode": "http",
      "botToken": "<SLACK_BOT_TOKEN>",
      "signingSecret": "your-signing-secret",
      "webhookPath": "/slack/events"
    }
  }
}
```

Lorsque `mode` est `"http"`, `signingSecret` est requis (validé par le schéma).

<div id="full-configuration-reference">

## Référence complète de configuration

</div>

Tous les champs sous `connectors.slack` :

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `botToken` | string | — | Token du bot (`xoxb-...`) |
| `appToken` | string | — | Token au niveau application (`xapp-...`) pour Socket Mode |
| `userToken` | string | — | Token utilisateur (`xoxp-...`) pour les appels API à portée utilisateur |
| `userTokenReadOnly` | boolean | `true` | Restreindre le token utilisateur aux opérations en lecture seule |
| `mode` | `"socket"` \| `"http"` | `"socket"` | Mode de transport |
| `signingSecret` | string | — | Secret de signature pour le mode HTTP (requis quand mode est `"http"`) |
| `webhookPath` | string | `"/slack/events"` | Chemin du endpoint webhook HTTP |
| `name` | string | — | Nom d'affichage du compte |
| `enabled` | boolean | — | Activer/désactiver explicitement |
| `capabilities` | string[] | — | Indicateurs de capacités |
| `allowBots` | boolean | `false` | Autoriser les messages de bots à déclencher des réponses |
| `requireMention` | boolean | — | Répondre uniquement lorsque mentionné avec @ |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Politique d'adhésion aux groupes/canaux |
| `historyLimit` | integer >= 0 | — | Nombre maximum de messages dans le contexte de conversation |
| `dmHistoryLimit` | integer >= 0 | — | Limite d'historique pour les messages directs |
| `dms` | Record\<string, \{historyLimit?\}\> | — | Surcharges d'historique par message direct |
| `textChunkLimit` | integer > 0 | — | Nombre maximum de caractères par fragment de message |
| `chunkMode` | `"length"` \| `"newline"` | — | Stratégie de découpage des messages longs |
| `blockStreaming` | boolean | — | Désactiver les réponses en streaming |
| `blockStreamingCoalesce` | object | — | Coalescence : `minChars`, `maxChars`, `idleMs` |
| `mediaMaxMb` | number > 0 | — | Taille maximale des fichiers média en Mo |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Mode de réponse en fil de discussion |
| `configWrites` | boolean | `true` | Autoriser les écritures de configuration depuis les événements Slack |
| `markdown` | object | — | Rendu des tableaux : `tables` peut être `"off"`, `"bullets"` ou `"code"` |
| `commands` | object | — | Options `native` et `nativeSkills` |

<div id="reply-to-mode-by-chat-type">

### Mode de réponse par type de chat

</div>

Surcharger `replyToMode` par type de chat :

```json
{
  "connectors": {
    "slack": {
      "replyToModeByChatType": {
        "direct": "all",
        "group": "first",
        "channel": "off"
      }
    }
  }
}
```

<div id="actions">

### Actions

</div>

| Champ | Type | Description |
|-------|------|-------------|
| `actions.reactions` | boolean | Ajouter des réactions |
| `actions.messages` | boolean | Envoyer des messages |
| `actions.pins` | boolean | Épingler des messages |
| `actions.search` | boolean | Rechercher des messages |
| `actions.permissions` | boolean | Gérer les permissions |
| `actions.memberInfo` | boolean | Voir les informations des membres |
| `actions.channelInfo` | boolean | Voir les informations du canal |
| `actions.emojiList` | boolean | Lister les emoji disponibles |

<div id="reaction-notifications">

### Notifications de réactions

</div>

| Champ | Type | Description |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | Quelles réactions déclenchent des notifications |
| `reactionAllowlist` | (string\|number)[] | Noms de réactions pour les notifications (lors de l'utilisation de `"allowlist"`) |

<div id="dm-policy">

### Politique de messages directs

</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `dm.enabled` | boolean | — | Activer/désactiver les messages directs |
| `dm.policy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Politique d'accès aux messages directs |
| `dm.allowFrom` | (string\|number)[] | — | IDs utilisateur autorisés. Doit inclure `"*"` pour la politique `"open"` |
| `dm.groupEnabled` | boolean | — | Activer les messages directs de groupe |
| `dm.groupChannels` | (string\|number)[] | — | IDs des canaux de messages directs de groupe autorisés |
| `dm.replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Mode de réponse en fil spécifique aux messages directs |

<div id="thread-configuration">

### Configuration des fils de discussion

</div>

| Champ | Type | Description |
|-------|------|-------------|
| `thread.historyScope` | `"thread"` \| `"channel"` | `"thread"` isole l'historique par fil. `"channel"` réutilise l'historique de conversation du canal |
| `thread.inheritParent` | boolean | Si les sessions de fils héritent de la transcription du canal parent (par défaut : false) |

<div id="slash-commands">

### Commandes slash

</div>

```json
{
  "connectors": {
    "slack": {
      "slashCommand": {
        "enabled": true,
        "name": "agent",
        "sessionPrefix": "slash",
        "ephemeral": true
      }
    }
  }
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `slashCommand.enabled` | boolean | Activer la gestion des commandes slash |
| `slashCommand.name` | string | Nom de la commande slash (ex., `/agent`) |
| `slashCommand.sessionPrefix` | string | Préfixe d'ID de session pour les conversations de commandes slash |
| `slashCommand.ephemeral` | boolean | Envoyer les réponses en éphémère (visibles uniquement par l'invocateur) |

<div id="channel-configuration">

### Configuration des canaux

</div>

Paramètres par canal sous `channels.<channel-id>` :

| Champ | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Activer/désactiver ce canal |
| `allow` | boolean | Autoriser le bot dans ce canal |
| `requireMention` | boolean | Répondre uniquement lorsque mentionné avec @ |
| `tools` | ToolPolicySchema | Politique d'accès aux outils |
| `toolsBySender` | Record\<string, ToolPolicySchema\> | Politiques d'outils par expéditeur |
| `allowBots` | boolean | Autoriser les messages de bots dans ce canal |
| `users` | (string\|number)[] | IDs utilisateur autorisés |
| `skills` | string[] | Compétences autorisées |
| `systemPrompt` | string | Prompt système spécifique au canal |

<div id="heartbeat">

### Heartbeat

</div>

```json
{
  "connectors": {
    "slack": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

<div id="multi-account-support">

### Support multi-comptes

</div>

```json
{
  "connectors": {
    "slack": {
      "accounts": {
        "workspace-1": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" },
        "workspace-2": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" }
      }
    }
  }
}
```

<div id="related">

## Associé

</div>

- [Référence du plugin Slack](/fr/plugin-registry/platform/slack)
- [Vue d'ensemble des connecteurs](/fr/guides/connectors)
- [Référence de configuration](/fr/configuration)
