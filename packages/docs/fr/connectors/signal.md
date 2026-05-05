---
title: Connecteur Signal
sidebarTitle: Signal
description: Connectez votre agent à Signal en utilisant le package @elizaos/plugin-signal.
---

Connectez votre agent à Signal pour la messagerie privée et de groupe via signal-cli.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Signal est un plugin externe elizaOS qui relie votre agent à Signal via signal-cli fonctionnant en mode HTTP ou JSON-RPC. Il est automatiquement activé par le runtime lorsqu'une configuration de compte valide est détectée.

<div id="package-info">

## Informations sur le package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-signal` |
| Clé de configuration | `connectors.signal` |
| Déclencheur d'activation automatique | `token`/`botToken`/`apiKey`, OU l'un parmi `authDir`/`account`/`httpUrl`/`httpHost`/`httpPort`/`cliPath`, OU `accounts` avec des entrées configurées |

<div id="minimal-configuration">

## Configuration minimale

</div>

Dans `~/.eliza/eliza.json` :

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="setup">

## Installation

</div>

<div id="1-install-signal-cli">

### 1. Installer signal-cli

</div>

Installez [signal-cli](https://github.com/AsamK/signal-cli) et enregistrez ou associez un compte Signal :

```bash
signal-cli -a +1234567890 register
signal-cli -a +1234567890 verify CODE
```

<div id="2-start-signal-cli-in-http-mode">

### 2. Démarrer signal-cli en mode HTTP

</div>

```bash
signal-cli -a +1234567890 daemon --http localhost:8080
```

<div id="3-configure-eliza">

### 3. Configurer Eliza

</div>

Ajoutez le bloc `connectors.signal` à `eliza.json` comme indiqué dans la configuration minimale ci-dessus.

<div id="disabling">

## Désactivation

</div>

Pour désactiver explicitement le connecteur même lorsqu'un compte est configuré :

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## Mécanisme d'activation automatique

</div>

Le module `plugin-auto-enable.ts` vérifie `connectors.signal` dans votre configuration. Le plugin s'active automatiquement lorsque l'une des conditions suivantes est remplie (et que `enabled` n'est pas explicitement `false`) :

- `account` est défini conjointement avec `httpUrl`
- `cliPath` est défini (chemin du binaire signal-cli pour le démarrage automatique)
- `accounts` contient au moins une entrée configurée

Aucune variable d'environnement n'est requise pour déclencher l'activation automatique — elle est entièrement pilotée par l'objet de configuration du connecteur.

<div id="environment-variables">

## Variables d'environnement

</div>

Le runtime injecte les variables d'environnement suivantes depuis votre configuration `connectors.signal` dans `process.env` via `CHANNEL_ENV_MAP`, afin que le plugin puisse les lire au démarrage :

| Variable d'environnement | Champ de configuration source | Description |
|---|---|---|
| `SIGNAL_AUTH_DIR` | `authDir` | Chemin vers le répertoire de données de signal-cli |
| `SIGNAL_ACCOUNT_NUMBER` | `account` | Numéro de téléphone Signal (E.164) |
| `SIGNAL_HTTP_URL` | `httpUrl` | URL HTTP du démon signal-cli |
| `SIGNAL_CLI_PATH` | `cliPath` | Chemin vers le binaire signal-cli |

Vous n'avez pas besoin de les définir manuellement — elles sont dérivées de la configuration du connecteur au moment de l'exécution.

<div id="full-configuration-reference">

## Référence complète de la configuration

</div>

Tous les champs sont définis sous `connectors.signal` dans `eliza.json`.

<div id="core-fields">

### Champs principaux

</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `account` | string | — | Numéro de téléphone Signal au format E.164 (ex. `+1234567890`) |
| `httpUrl` | string | — | URL HTTP du démon signal-cli (ex. `http://localhost:8080`) |
| `httpHost` | string | — | Nom d'hôte alternatif à `httpUrl` |
| `httpPort` | integer > 0 | — | Port alternatif à `httpUrl` |
| `cliPath` | string | — | Chemin vers le binaire signal-cli pour le démarrage automatique |
| `autoStart` | boolean | — | Démarrer automatiquement signal-cli au chargement du connecteur |
| `startupTimeoutMs` | integer (1000-120000) | — | Millisecondes d'attente pour le démarrage du CLI (1-120 secondes) |
| `receiveMode` | `"on-start"` \| `"manual"` | `"on-start"` | Moment où commencer à recevoir les messages |
| `name` | string | — | Nom d'affichage du compte |
| `enabled` | boolean | — | Activer/désactiver explicitement |
| `capabilities` | string[] | — | Indicateurs de capacités |
| `configWrites` | boolean | — | Autoriser les écritures de configuration depuis les événements Signal |

<div id="message-handling">

### Gestion des messages

</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `ignoreAttachments` | boolean | — | Ignorer les pièces jointes entrantes (le comportement par défaut les inclut) |
| `ignoreStories` | boolean | — | Ignorer les messages de stories (le comportement par défaut les exclut) |
| `sendReadReceipts` | boolean | — | Envoyer des accusés de lecture pour les messages reçus |
| `historyLimit` | integer >= 0 | — | Nombre maximum de messages dans le contexte |
| `dmHistoryLimit` | integer >= 0 | — | Limite d'historique pour les messages privés |
| `dms` | object | — | Remplacements d'historique par message privé, indexés par identifiant de conversation. Chaque valeur : `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Nombre maximum de caractères par segment de message |
| `chunkMode` | `"length"` \| `"newline"` | — | Stratégie de découpage des messages longs |
| `mediaMaxMb` | integer > 0 | — | Taille maximale des fichiers média en Mo |
| `markdown` | object | — | Rendu des tableaux : `tables` peut être `"off"`, `"bullets"` ou `"code"` |

<div id="access-policies">

### Politiques d'accès

</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Politique d'accès aux messages privés. `"open"` nécessite que `allowFrom` inclue `"*"` |
| `allowFrom` | (string\|number)[] | — | Identifiants des utilisateurs autorisés à envoyer des messages privés |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Politique d'adhésion aux groupes |
| `groupAllowFrom` | (string\|number)[] | — | Identifiants des utilisateurs autorisés dans les groupes |

<div id="streaming-configuration">

### Configuration du streaming

</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `blockStreaming` | boolean | — | Désactiver entièrement le streaming |
| `blockStreamingCoalesce` | object | — | Paramètres de coalescence : `minChars`, `maxChars`, `idleMs` |

<div id="actions">

### Actions

</div>

| Champ | Type | Description |
|-------|------|-------------|
| `actions.reactions` | boolean | Envoyer des réactions |

<div id="reaction-notifications">

### Notifications de réactions

</div>

| Champ | Type | Description |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | Quelles réactions déclenchent des notifications |
| `reactionAllowlist` | (string\|number)[] | Identifiants des utilisateurs dont les réactions déclenchent des notifications (lorsque `reactionNotifications` est `"allowlist"`) |
| `reactionLevel` | `"off"` \| `"ack"` \| `"minimal"` \| `"extensive"` | Verbosité de la réponse aux réactions |

<div id="heartbeat">

### Heartbeat

</div>

```json
{
  "connectors": {
    "signal": {
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

### Prise en charge multi-comptes

</div>

Le champ `accounts` permet d'exécuter plusieurs comptes Signal depuis un seul agent :

```json
{
  "connectors": {
    "signal": {
      "accounts": {
        "personal": {
          "account": "+1234567890",
          "httpUrl": "http://localhost:8080",
          "dmPolicy": "pairing"
        },
        "work": {
          "account": "+0987654321",
          "httpUrl": "http://localhost:8081",
          "dmPolicy": "allowlist",
          "allowFrom": ["+1111111111"]
        }
      }
    }
  }
}
```

Chaque entrée de compte accepte les mêmes champs que la configuration `connectors.signal` de niveau supérieur. Les champs de niveau supérieur servent de valeurs par défaut que les comptes individuels peuvent remplacer.

<div id="validation">

## Validation

</div>

- Lorsque `dmPolicy` est `"open"`, le tableau `allowFrom` doit inclure `"*"`.
- `startupTimeoutMs` doit être compris entre 1000 et 120000 (1-120 secondes).

<div id="related">

## Voir aussi

</div>

- [Référence du plugin Signal](/fr/plugin-registry/platform/signal)
- [Vue d'ensemble des connecteurs](/fr/guides/connectors)
- [Référence de la configuration](/fr/configuration)
