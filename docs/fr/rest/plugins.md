---
title: "API Plugins et Registre"
sidebarTitle: "Plugins"
description: "Points de terminaison de l'API REST pour la gestion des plugins, le registre de plugins elizaOS et les opérations sur les plugins principaux."
---

L'API plugins gère le système de plugins de l'agent. Elle couvre trois domaines : **la gestion des plugins** (lister, configurer, activer/désactiver les plugins installés), **l'installation de plugins** (installer, désinstaller, éjecter, synchroniser depuis npm) et le **registre de plugins** (parcourir le catalogue communautaire elizaOS).

Lorsque `ELIZA_API_TOKEN` est défini, incluez-le comme jeton `Bearer` dans l'en-tête `Authorization`.

<div id="endpoints">

## Points de terminaison

</div>

<div id="plugin-management">

### Gestion des plugins

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/plugins` | Lister tous les plugins avec leur statut et leur configuration |
| PUT | `/api/plugins/:id` | Mettre à jour un plugin (activer/désactiver, configurer) |
| POST | `/api/plugins/:id/test` | Tester la connectivité d'un plugin |
| GET | `/api/plugins/installed` | Lister les paquets de plugins installés |
| GET | `/api/plugins/ejected` | Lister les plugins éjectés (copie locale) |

<div id="plugin-installation">

### Installation de plugins

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/plugins/install` | Installer un plugin depuis npm |
| POST | `/api/plugins/uninstall` | Désinstaller un plugin |
| POST | `/api/plugins/:id/eject` | Éjecter un plugin vers une copie locale |
| POST | `/api/plugins/:id/sync` | Synchroniser un plugin éjecté avec npm |
| POST | `/api/plugins/:id/reinject` | Restaurer un plugin éjecté vers sa version du registre |

<div id="core-plugin-management">

### Gestion des plugins principaux

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/core/status` | Statut du gestionnaire principal |
| GET | `/api/plugins/core` | Lister les plugins principaux avec leur statut |
| POST | `/api/plugins/core/toggle` | Basculer un plugin principal |

<div id="plugin-registry">

### Registre de plugins

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/registry/plugins` | Lister tous les plugins du registre |
| GET | `/api/registry/plugins/:name` | Obtenir les détails d'un plugin du registre |
| GET | `/api/registry/search` | Rechercher dans le registre |
| POST | `/api/registry/refresh` | Rafraîchir le cache du registre |
| GET | `/api/registry/status` | Statut de connexion au registre |
| POST | `/api/registry/register` | Enregistrer l'agent auprès du registre |
| POST | `/api/registry/update-uri` | Mettre à jour l'URI de l'agent dans le registre |
| POST | `/api/registry/sync` | Synchroniser l'état de l'agent avec le registre |
| GET | `/api/registry/config` | Obtenir la configuration du registre |

---

<div id="plugin-management-1">

## Gestion des plugins

</div>

<div id="get-apiplugins">

### GET /api/plugins

</div>

Lister tous les plugins connus — intégrés, installés et découverts depuis la configuration. Chaque entrée inclut l'état activé/actif, les paramètres de configuration avec les valeurs actuelles (les valeurs sensibles sont masquées) et les résultats de validation.

**Réponse**

```json
{
  "plugins": [
    {
      "id": "twitter",
      "name": "Twitter",
      "description": "Twitter/X integration",
      "category": "social",
      "enabled": true,
      "isActive": true,
      "configured": true,
      "loadError": null,
      "parameters": [
        {
          "key": "TWITTER_API_KEY",
          "required": true,
          "sensitive": true,
          "isSet": true,
          "currentValue": "sk-****...xxxx"
        }
      ],
      "validationErrors": [],
      "validationWarnings": []
    }
  ]
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `id` | string | Identifiant du plugin |
| `enabled` | boolean | Si l'utilisateur souhaite qu'il soit actif (piloté par la configuration) |
| `isActive` | boolean | S'il est effectivement chargé dans le runtime |
| `configured` | boolean | Si tous les paramètres requis sont définis |
| `loadError` | string\|null | Message d'erreur si installé mais échec du chargement |

---

<div id="put-apipluginsid">

### PUT /api/plugins/:id

</div>

Mettre à jour l'état d'activation et/ou la configuration d'un plugin. L'activation/désactivation d'un plugin planifie un redémarrage du runtime.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `enabled` | boolean | Non | Activer ou désactiver le plugin |
| `config` | object | Non | Correspondance des clés de paramètres vers les nouvelles valeurs |

```json
{
  "enabled": true,
  "config": {
    "TWITTER_API_KEY": "sk-new-key"
  }
}
```

**Réponse**

```json
{
  "ok": true,
  "plugin": { "id": "twitter", "enabled": true, "..." : "..." }
}
```

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 404 | Plugin non trouvé |
| 422 | Échec de la validation de la configuration |

---

<div id="post-apipluginsidtest">

### POST /api/plugins/:id/test

</div>

Tester la connectivité ou la configuration d'un plugin. Le comportement du test est spécifique au plugin (par ex. vérification de la validité de la clé API, vérification de l'accessibilité du point de terminaison).

**Réponse**

```json
{
  "ok": true,
  "result": { "..." : "..." }
}
```

---

<div id="get-apipluginsinstalled">

### GET /api/plugins/installed

</div>

Lister tous les paquets de plugins installés avec les informations de version.

**Réponse**

```json
{
  "count": 3,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "version": "1.2.0",
      "installedAt": "2025-06-01T12:00:00.000Z"
    }
  ]
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `count` | number | Nombre total de plugins installés |
| `plugins` | array | Liste des paquets de plugins installés |

---

<div id="get-apipluginsejected">

### GET /api/plugins/ejected

</div>

Lister tous les plugins éjectés (plugins copiés dans un répertoire local pour le développement).

**Réponse**

```json
{
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "localPath": "/path/to/local/plugin-twitter"
    }
  ]
}
```

---

<div id="plugin-installation-1">

## Installation de plugins

</div>

<div id="post-apipluginsinstall">

### POST /api/plugins/install

</div>

Installer un paquet de plugin depuis npm. L'installation d'un plugin peut prendre un temps considérable selon la taille du paquet et l'arbre de dépendances. Le SDK client utilise un délai d'attente de 120 secondes pour ce point de terminaison (comparé au délai par défaut utilisé pour les autres appels API).

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du paquet npm |
| `autoRestart` | boolean | Non | Redémarrer l'agent après l'installation (par défaut `true`) |

**Réponse**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsuninstall">

### POST /api/plugins/uninstall

</div>

Désinstaller un paquet de plugin.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du paquet npm |

**Réponse**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsideject">

### POST /api/plugins/:id/eject

</div>

Éjecter un plugin vers un répertoire local pour le développement. Crée une copie locale du code source du plugin qui peut être modifiée indépendamment. Si le résultat indique qu'un redémarrage est nécessaire, le runtime planifie un redémarrage automatique.

**Réponse**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x ejected to local source."
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Nom du plugin éjecté |
| `requiresRestart` | boolean | Si le runtime va redémarrer pour charger la copie locale |
| `message` | string | Message de statut lisible |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 422 | Échec de l'éjection (plugin non trouvé ou déjà éjecté) |

---

<div id="post-apipluginsidsync">

### POST /api/plugins/:id/sync

</div>

Synchroniser un plugin éjecté — reconstruire depuis la copie locale.

**Réponse**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x synced with upstream."
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Nom du plugin synchronisé |
| `requiresRestart` | boolean | Si le runtime va redémarrer pour appliquer les modifications |
| `message` | string | Message de statut lisible |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 422 | Échec de la synchronisation (plugin non éjecté ou erreur de synchronisation) |

---

<div id="post-apipluginsidsreinject">

### POST /api/plugins/:id/reinject

</div>

Restaurer un plugin précédemment éjecté vers sa version du registre, en supprimant la copie locale.

**Réponse**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x restored to registry version."
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `pluginName` | string | Nom du plugin réinjecté |
| `requiresRestart` | boolean | Si le runtime va redémarrer pour charger la version du registre |
| `message` | string | Message de statut lisible |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 422 | Échec de la réinjection (plugin non éjecté ou erreur de réinjection) |

---

<div id="core-plugin-management-1">

## Gestion des plugins principaux

</div>

<div id="get-apicorestatus">

### GET /api/core/status

</div>

Obtenir le statut du gestionnaire principal et les plugins principaux disponibles.

**Réponse**

```json
{
  "available": true,
  "corePlugins": ["knowledge", "sql"],
  "optionalCorePlugins": ["plugin-manager"]
}
```

- **knowledge** -- Récupération de connaissances RAG
- **sql** -- Couche base de données

---

<div id="get-apipluginscore">

### GET /api/plugins/core

</div>

Lister les plugins principaux et optionnels avec leur statut activé/chargé.

**Réponse**

```json
{
  "core": [
    { "name": "knowledge", "loaded": true, "required": true },
    { "name": "sql", "loaded": true, "required": true }
  ],
  "optionalCore": [
    { "name": "plugin-manager", "loaded": true, "required": false, "enabled": true }
  ]
}
```

---

<div id="post-apipluginscoretoggle">

### POST /api/plugins/core/toggle

</div>

Basculer un plugin principal optionnel entre activé et désactivé.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Oui | Nom du plugin principal |
| `enabled` | boolean | Oui | État souhaité |

**Réponse**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="plugin-registry-1">

## Registre de plugins

</div>

<div id="get-apiregistryplugins">

### GET /api/registry/plugins

</div>

Lister tous les plugins du registre elizaOS avec le statut d'installation et de chargement.

**Réponse**

```json
{
  "count": 87,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration for posting and monitoring",
      "npm": {
        "package": "@elizaos/plugin-x",
        "version": "1.2.0"
      },
      "installed": false,
      "installedVersion": null,
      "loaded": false,
      "bundled": false
    }
  ]
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `name` | string | Nom complet du paquet npm |
| `installed` | boolean | Si ce plugin est actuellement installé |
| `installedVersion` | string\|null | Version installée, ou `null` si non installé |
| `loaded` | boolean | Si ce plugin est chargé dans le runtime de l'agent en cours d'exécution |
| `bundled` | boolean | Si ce plugin est intégré dans le binaire Eliza |

---

<div id="get-apiregistryplugins-name">

### GET /api/registry/plugins/:name

</div>

Obtenir les détails d'un plugin spécifique du registre. Le paramètre `name` doit être encodé en URL s'il contient des barres obliques (par ex. `%40elizaos%2Fplugin-twitter`).

**Paramètres de chemin**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `name` | string | Oui | Nom complet du paquet npm (encodé en URL) |

**Réponse**

```json
{
  "plugin": {
    "name": "@elizaos/plugin-x",
    "displayName": "Twitter",
    "description": "Twitter/X integration for posting and monitoring",
    "npm": {
      "package": "@elizaos/plugin-x",
      "version": "1.2.0"
    },
    "author": "elizaOS Team",
    "repository": "https://github.com/elizaos/eliza",
    "tags": ["social", "twitter"],
    "installed": false,
    "loaded": false,
    "bundled": false
  }
}
```

---

<div id="get-apiregistrysearch">

### GET /api/registry/search

</div>

Rechercher dans le registre de plugins par mot-clé.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `q` | string | Oui | Requête de recherche |
| `limit` | integer | Non | Nombre maximum de résultats à retourner (par défaut : 15, max : 50) |

**Réponse**

```json
{
  "query": "twitter",
  "count": 2,
  "results": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration",
      "npmPackage": "@elizaos/plugin-x",
      "version": "1.2.0"
    }
  ]
}
```

---

<div id="post-apiregistryrefresh">

### POST /api/registry/refresh

</div>

Forcer le rafraîchissement du cache local du registre depuis le registre elizaOS en amont.

**Réponse**

```json
{
  "ok": true,
  "count": 87
}
```

---

<div id="get-apiregistrystatus">

### GET /api/registry/status

</div>

Obtenir le statut de connexion de l'agent au registre.

**Réponse**

Lorsque le service de registre est configuré :

```json
{
  "registered": true,
  "configured": true,
  "tokenId": 1,
  "agentName": "Eliza",
  "agentEndpoint": "https://...",
  "capabilitiesHash": "...",
  "isActive": true,
  "tokenURI": "https://...",
  "walletAddress": "0x...",
  "totalAgents": 42
}
```

Lorsque le service de registre n'est pas configuré :

```json
{
  "registered": false,
  "configured": false,
  "tokenId": 0,
  "agentName": "",
  "agentEndpoint": "",
  "capabilitiesHash": "",
  "isActive": false,
  "tokenURI": "",
  "walletAddress": "",
  "totalAgents": 0
}
```

---

<div id="post-apiregistryregister">

### POST /api/registry/register

</div>

Enregistrer l'agent auprès du registre elizaOS.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Non | Remplacement du nom de l'agent |
| `endpoint` | string | Non | URL du point de terminaison public |
| `tokenURI` | string | Non | URI du jeton pour l'enregistrement |

**Réponse**

Retourne le résultat de l'enregistrement du service de registre (le schéma dépend de l'implémentation du registre).

---

<div id="post-apiregistryupdate-uri">

### POST /api/registry/update-uri

</div>

Mettre à jour l'URI du jeton de l'agent dans le registre.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `tokenURI` | string | Oui | Nouvelle URI du jeton |

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiregistrysync">

### POST /api/registry/sync

</div>

Synchroniser l'état de l'agent avec le registre (battement de cœur, mise à jour du statut).

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | string | Non | Remplacement du nom de l'agent |
| `endpoint` | string | Non | URL du point de terminaison public |
| `tokenURI` | string | Non | URI du jeton |

**Réponse**

```json
{
  "ok": true,
  "txHash": "0x..."
}
```

---

<div id="get-apiregistryconfig">

### GET /api/registry/config

</div>

Obtenir la configuration actuelle du registre. Retourne le contenu de `config.registry` ainsi que les métadonnées de la chaîne.

**Réponse**

```json
{
  "chainId": 1,
  "explorerUrl": "https://etherscan.io",
  "...": "additional fields from config.registry"
}
```

La forme exacte de la réponse dépend de ce qui est configuré dans `eliza.json` sous la clé `registry`.
