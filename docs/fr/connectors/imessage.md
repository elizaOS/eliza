---
title: Connecteur iMessage
sidebarTitle: iMessage
description: Connectez votre agent à iMessage en utilisant le package @elizaos/plugin-imessage.
---

Connectez votre agent à iMessage pour les discussions privées et les conversations de groupe sur macOS.

<div id="overview">
## Vue d'ensemble
</div>

Le connecteur iMessage est un plugin externe elizaOS qui relie votre agent à iMessage et SMS sur macOS. Il accède directement à la base de données native d'iMessage et prend en charge la connectivité avec des hôtes distants via SSH. Il est activé automatiquement par le runtime lorsqu'un chemin CLI est détecté dans la configuration de votre connecteur.

<div id="package-info">
## Informations sur le package
</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-imessage` |
| Clé de configuration | `connectors.imessage` |
| Déclencheur d'activation automatique | `cliPath` est vrai dans la configuration du connecteur |

<div id="prerequisites">
## Prérequis
</div>

- macOS avec iMessage configuré et connecté
- Accès complet au disque accordé au terminal ou à l'application exécutant Eliza (pour l'accès à la base de données de chat à `~/Library/Messages/chat.db`)
- Un outil CLI pour l'accès à iMessage (par ex., `imessage-exporter`)

<div id="minimal-configuration">
## Configuration minimale
</div>

Dans `~/.eliza/eliza.json` :

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="disabling">
## Désactivation
</div>

Pour désactiver explicitement le connecteur même lorsqu'un chemin CLI est présent :

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">
## Mécanisme d'activation automatique
</div>

Le module `plugin-auto-enable.ts` vérifie `connectors.imessage` dans votre configuration. Si le champ `cliPath` est vrai (et `enabled` n'est pas explicitement `false`), le runtime charge automatiquement `@elizaos/plugin-imessage`.

Aucune variable d'environnement n'est requise pour déclencher l'activation automatique — elle est entièrement pilotée par l'objet de configuration du connecteur.

<div id="full-configuration-reference">
## Référence complète de configuration
</div>

Tous les champs sont définis sous `connectors.imessage` dans `eliza.json`.

<div id="core-fields">
### Champs principaux
</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `cliPath` | string | — | Chemin vers l'exécutable de l'outil CLI iMessage |
| `dbPath` | string | — | Chemin vers la base de données iMessage (défaut : `~/Library/Messages/chat.db`) |
| `remoteHost` | string | — | Nom d'hôte du Mac distant pour l'accès iMessage via SSH |
| `service` | `"imessage"` \| `"sms"` \| `"auto"` | — | Sélection du service de messagerie. `"auto"` détecte le service approprié |
| `region` | string | — | Configuration de région pour le formatage des numéros de téléphone |
| `name` | string | — | Nom d'affichage du compte |
| `enabled` | boolean | — | Activer/désactiver explicitement |
| `capabilities` | string[] | — | Indicateurs de capacités |
| `includeAttachments` | boolean | — | Inclure les pièces jointes dans les messages |
| `configWrites` | boolean | — | Autoriser l'écriture de configuration depuis les événements iMessage |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Politique d'accès aux DMs. `"open"` nécessite que `allowFrom` inclue `"*"` |
| `allowFrom` | (string\|number)[] | — | IDs d'utilisateurs autorisés à envoyer des DMs |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Politique d'adhésion aux groupes |
| `groupAllowFrom` | (string\|number)[] | — | IDs d'utilisateurs autorisés dans les groupes |
| `historyLimit` | integer >= 0 | — | Maximum de messages en contexte |
| `dmHistoryLimit` | integer >= 0 | — | Limite d'historique pour les DMs |
| `dms` | object | — | Surcharges d'historique par DM indexées par ID de DM. Chaque valeur : `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Maximum de caractères par fragment de message |
| `chunkMode` | `"length"` \| `"newline"` | — | Stratégie de découpage des messages longs |
| `mediaMaxMb` | integer > 0 | — | Taille maximale des fichiers média en Mo |
| `markdown` | object | — | Rendu des tableaux : `tables` peut être `"off"`, `"bullets"` ou `"code"` |

<div id="streaming-configuration">
### Configuration du streaming
</div>

| Champ | Type | Défaut | Description |
|-------|------|--------|-------------|
| `blockStreaming` | boolean | — | Désactiver complètement le streaming |
| `blockStreamingCoalesce` | object | — | Paramètres de coalescence : `minChars`, `maxChars`, `idleMs` |

<div id="group-configuration">
### Configuration des groupes
</div>

Les paramètres par groupe sont définis sous `groups.<group-id>` :

| Champ | Type | Description |
|-------|------|-------------|
| `requireMention` | boolean | Répondre uniquement lorsque mentionné avec @ |
| `tools` | ToolPolicySchema | Politique d'accès aux outils |
| `toolsBySender` | object | Politiques d'outils par expéditeur (indexées par ID d'expéditeur) |

<div id="heartbeat">
### Heartbeat
</div>

```json
{
  "connectors": {
    "imessage": {
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

Le champ `accounts` permet d'exécuter plusieurs comptes iMessage depuis un seul agent :

```json
{
  "connectors": {
    "imessage": {
      "accounts": {
        "personal": {
          "cliPath": "/usr/local/bin/imessage",
          "service": "imessage",
          "groups": {}
        },
        "work": {
          "cliPath": "/usr/local/bin/imessage",
          "remoteHost": "work-mac.local",
          "service": "auto",
          "groups": {}
        }
      }
    }
  }
}
```

Chaque entrée de compte prend en charge les mêmes champs que la configuration de niveau supérieur `connectors.imessage` (à l'exclusion du champ `accounts` lui-même).

<div id="remote-host-access">
## Accès à l'hôte distant
</div>

Pour vous connecter à iMessage sur un Mac distant via SSH, définissez le champ `remoteHost` :

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "remoteHost": "mac-mini.local"
    }
  }
}
```

Assurez-vous que l'authentification SSH par clé est configurée entre la machine locale et l'hôte distant.

<div id="troubleshooting">
## Dépannage
</div>

<div id="full-disk-access">
### Accès complet au disque
</div>

Si la récupération des messages échoue, assurez-vous que l'Accès complet au disque est accordé :

1. Ouvrez **Réglages Système > Confidentialité et sécurité > Accès complet au disque**
2. Ajoutez l'application de terminal ou le processus Eliza

<div id="database-path">
### Chemin de la base de données
</div>

La base de données iMessage par défaut se trouve à `~/Library/Messages/chat.db`. Si vous utilisez un emplacement non standard, définissez `dbPath` explicitement.

<div id="macos-only">
### macOS uniquement
</div>

Le connecteur iMessage nécessite macOS. Il ne fonctionnera pas sous Linux ou Windows.

<div id="related">
## Liens connexes
</div>

- [Référence du plugin iMessage](/fr/plugin-registry/platform/imessage)
- [Vue d'ensemble des connecteurs](/fr/guides/connectors)
- [Référence de configuration](/fr/configuration)
