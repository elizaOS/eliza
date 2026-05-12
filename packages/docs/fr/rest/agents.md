---
title: "API des agents"
sidebarTitle: "Agents"
description: "Points de terminaison de l'API REST pour le cycle de vie des agents, l'administration et le transfert (export/import)."
---

Tous les points de terminaison des agents nécessitent que le runtime de l'agent soit initialisé. Le serveur API s'exécute sur le port **31337** par défaut et tous les chemins sont préfixés par `/api/`. Lorsque `ELIZA_API_TOKEN` est défini, incluez-le comme jeton `Bearer` dans l'en-tête `Authorization`.

<div id="endpoints">

## Points de terminaison

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/agent/start` | Démarrer l'agent et activer l'autonomie |
| POST | `/api/agent/stop` | Arrêter l'agent et désactiver l'autonomie |
| POST | `/api/agent/pause` | Mettre l'agent en pause (conserver le temps d'activité, désactiver l'autonomie) |
| POST | `/api/agent/resume` | Reprendre un agent en pause et réactiver l'autonomie |
| POST | `/api/agent/restart` | Redémarrer le runtime de l'agent |
| POST | `/api/agent/reset` | Effacer la configuration, l'espace de travail, la mémoire et revenir à l'intégration |
| POST | `/api/agent/export` | Exporter l'agent sous forme de fichier binaire `.eliza-agent` chiffré par mot de passe |
| GET | `/api/agent/export/estimate` | Estimer la taille du fichier d'export avant le téléchargement |
| POST | `/api/agent/import` | Importer un agent depuis un fichier `.eliza-agent` chiffré par mot de passe |
| GET | `/api/agent/self-status` | Résumé structuré de l'auto-statut avec les capacités, le portefeuille, les plugins et la conscience |

---

<div id="post-apiagentstart">

### POST /api/agent/start

</div>

Démarrer l'agent et activer le fonctionnement autonome. Définit l'état de l'agent sur `running`, enregistre l'horodatage de démarrage et active la tâche d'autonomie pour que le premier tick se déclenche immédiatement.

**Réponse**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 0,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentstop">

### POST /api/agent/stop

</div>

Arrêter l'agent et désactiver l'autonomie. Définit l'état de l'agent sur `stopped` et efface le suivi du temps d'activité.

**Réponse**

```json
{
  "ok": true,
  "status": {
    "state": "stopped",
    "agentName": "Eliza"
  }
}
```

---

<div id="post-apiagentpause">

### POST /api/agent/pause

</div>

Mettre l'agent en pause tout en conservant le temps d'activité intact. Désactive l'autonomie mais préserve l'horodatage `startedAt` et les informations du modèle.

**Réponse**

```json
{
  "ok": true,
  "status": {
    "state": "paused",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentresume">

### POST /api/agent/resume

</div>

Reprendre un agent en pause et réactiver l'autonomie. Le premier tick se déclenche immédiatement.

**Réponse**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentrestart">

### POST /api/agent/restart

</div>

Redémarrer le runtime de l'agent. Retourne `409` si un redémarrage est déjà en cours et `501` si le redémarrage n'est pas pris en charge dans le mode actuel.

**Réponse**

```json
{
  "ok": true,
  "pendingRestart": false,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentreset">

### POST /api/agent/reset

</div>

Effacer la configuration, l'espace de travail (mémoire), les jetons OAuth et revenir à l'état d'intégration. Arrête le runtime, supprime le répertoire d'état `~/.eliza/` (avec des vérifications de sécurité pour empêcher la suppression de chemins système) et réinitialise tout l'état du serveur.

**Réponse**

```json
{
  "ok": true
}
```

---

<div id="post-apiagentexport">

### POST /api/agent/export

</div>

Exporter l'agent entier sous forme de fichier binaire `.eliza-agent` chiffré par mot de passe. L'agent doit être en cours d'exécution. Retourne un téléchargement de fichier `application/octet-stream`.

**Requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `password` | string | Oui | Mot de passe de chiffrement — minimum 4 caractères |
| `includeLogs` | boolean | Non | Inclure ou non les fichiers journaux dans l'export |

**Réponse**

Téléchargement de fichier binaire avec `Content-Disposition: attachment; filename="agentname-YYYY-MM-DDTHH-MM-SS.eliza-agent"`.

---

<div id="get-apiagentexportestimate">

### GET /api/agent/export/estimate

</div>

Estimer la taille du fichier d'export avant le téléchargement. L'agent doit être en cours d'exécution.

**Réponse**

```json
{
  "estimatedBytes": 1048576,
  "estimatedMb": 1.0
}
```

---

<div id="post-apiagentimport">

### POST /api/agent/import

</div>

Importer un agent depuis un fichier `.eliza-agent` chiffré par mot de passe. Le corps de la requête est une enveloppe binaire : `[4 octets longueur du mot de passe (uint32 big-endian)][octets du mot de passe][données du fichier]`. La taille maximale d'import est de 512 Mo.

**Requête**

Corps binaire brut — pas du JSON. Les 4 premiers octets encodent la longueur du mot de passe sous forme d'entier non signé 32 bits big-endian, suivi du mot de passe en UTF-8, suivi des données du fichier.

**Réponse**

```json
{
  "ok": true
}
```

<div id="get-apiagentself-status">

### GET /api/agent/self-status

</div>

Obtenir un résumé structuré de l'état actuel de l'agent, de ses capacités, de l'état du portefeuille, des plugins actifs et d'un instantané optionnel du registre de conscience. Conçu pour les consommateurs programmatiques et le système d'auto-conscience de l'agent.

**Réponse**

```json
{
  "generatedAt": "2026-04-09T12:00:00.000Z",
  "state": "running",
  "agentName": "Eliza",
  "model": "anthropic/claude-sonnet-4.6",
  "provider": "anthropic",
  "automationMode": "connectors-only",
  "tradePermissionMode": "ask",
  "shellEnabled": true,
  "wallet": {
    "hasWallet": true,
    "hasEvm": true,
    "hasSolana": false,
    "evmAddress": "0x1234...abcd",
    "evmAddressShort": "0x1234...abcd",
    "solanaAddress": null,
    "solanaAddressShort": null,
    "localSignerAvailable": true,
    "managedBscRpcReady": true
  },
  "plugins": {
    "totalActive": 12,
    "active": ["..."],
    "aiProviders": ["@elizaos/plugin-anthropic"],
    "connectors": ["@elizaos/plugin-discord"]
  },
  "capabilities": {
    "canTrade": true,
    "canLocalTrade": true,
    "canAutoTrade": false,
    "canUseBrowser": false,
    "canUseComputer": false,
    "canRunTerminal": true,
    "canInstallPlugins": true,
    "canConfigurePlugins": true,
    "canConfigureConnectors": true
  },
  "registrySummary": "Runtime: running | Wallet: EVM ready | Plugins: 12 active | Cloud: disconnected"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `generatedAt` | string | Horodatage ISO 8601 indiquant quand la réponse a été générée |
| `state` | string | État actuel de l'agent (`not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, `error`) |
| `agentName` | string | Nom d'affichage de l'agent |
| `model` | string\|null | Identifiant du modèle actif, résolu à partir de l'état du runtime, de la configuration ou de l'environnement |
| `provider` | string\|null | Libellé du fournisseur d'IA dérivé de la chaîne du modèle |
| `automationMode` | string | `"connectors-only"` ou `"full"` — contrôle la portée du comportement autonome |
| `tradePermissionMode` | string | Niveau de permission de trading depuis la configuration |
| `shellEnabled` | boolean | Indique si l'accès au shell/terminal est activé |
| `wallet` | object | Résumé de l'état du portefeuille (voir ci-dessous) |
| `plugins` | object | Résumé des plugins actifs (voir ci-dessous) |
| `capabilities` | object | Indicateurs booléens de capacités (voir ci-dessous) |
| `registrySummary` | string\|undefined | Résumé en une ligne du registre de conscience, si disponible |

**Champs `wallet`**

| Champ | Type | Description |
|-------|------|-------------|
| `hasWallet` | boolean | `true` si une adresse de portefeuille est configurée |
| `hasEvm` | boolean | `true` si une adresse EVM est disponible |
| `hasSolana` | boolean | `true` si une adresse Solana est disponible |
| `evmAddress` | string\|null | Adresse EVM complète |
| `evmAddressShort` | string\|null | Adresse EVM abrégée (`0x1234...abcd`) |
| `solanaAddress` | string\|null | Adresse Solana complète |
| `solanaAddressShort` | string\|null | Adresse Solana abrégée |
| `localSignerAvailable` | boolean | `true` si `EVM_PRIVATE_KEY` est défini |
| `managedBscRpcReady` | boolean | `true` si le point de terminaison RPC BSC géré est configuré |

**Champs `plugins`**

| Champ | Type | Description |
|-------|------|-------------|
| `totalActive` | number | Nombre de plugins actifs |
| `active` | string[] | Noms de tous les plugins actifs |
| `aiProviders` | string[] | Noms des plugins fournisseurs d'IA actifs |
| `connectors` | string[] | Noms des plugins connecteurs actifs (Discord, Telegram, etc.) |

**Champs `capabilities`**

| Champ | Type | Description |
|-------|------|-------------|
| `canTrade` | boolean | `true` si le portefeuille et le RPC sont configurés pour le trading |
| `canLocalTrade` | boolean | `true` si l'exécution locale de transactions est disponible (portefeuille + signataire + permission) |
| `canAutoTrade` | boolean | `true` si l'agent peut exécuter des transactions de manière autonome |
| `canUseBrowser` | boolean | `true` si un plugin de navigateur est chargé |
| `canUseComputer` | boolean | `true` si un plugin d'utilisation d'ordinateur est chargé |
| `canRunTerminal` | boolean | `true` si l'accès au shell est activé |
| `canInstallPlugins` | boolean | `true` si l'installation de plugins est disponible |
| `canConfigurePlugins` | boolean | `true` si la configuration de plugins est disponible |
| `canConfigureConnectors` | boolean | `true` si la configuration de connecteurs est disponible |

---

<div id="common-error-codes">

## Codes d'erreur courants

</div>

| Statut | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Le corps de la requête est malformé ou des champs requis sont manquants |
| 401 | `UNAUTHORIZED` | Jeton d'authentification manquant ou invalide |
| 404 | `NOT_FOUND` | La ressource demandée n'existe pas |
| 409 | `STATE_CONFLICT` | L'agent est dans un état invalide pour cette opération |
| 500 | `INTERNAL_ERROR` | Erreur serveur inattendue |
| 500 | `AGENT_NOT_FOUND` | Runtime de l'agent introuvable ou non initialisé |
