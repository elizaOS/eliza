---
title: Actions Personnalisées
sidebarTitle: Actions Personnalisées
description: Définissez des capacités créées par l'utilisateur avec des handlers HTTP, shell et de code qui étendent ce que l'agent peut faire.
---

Les actions sont le moyen principal par lequel les agents interagissent avec le monde. Elles représentent des capacités discrètes -- des choses que l'agent peut faire en réponse au contexte de la conversation. Eliza est livré avec des actions intégrées et fournit un système pour définir vos propres actions personnalisées sans écrire de code de plugin.

<div id="action-interface">

## Interface d'Action

</div>

Dans le runtime elizaOS, une `Action` est un objet avec :

- **name** -- Identifiant unique que le runtime utilise pour sélectionner l'action (p. ex., `RESTART_AGENT`).
- **similes** -- Noms alternatifs qui aident l'agent à faire correspondre l'intention de l'utilisateur (p. ex., `REBOOT`, `RELOAD`).
- **description** -- Texte lisible que l'agent utilise pour décider quand cette action est appropriée.
- **validate** -- Fonction asynchrone retournant si l'action peut s'exécuter dans le contexte actuel.
- **handler** -- Fonction asynchrone qui exécute l'action et retourne les résultats.
- **parameters** -- Tableau de définitions de paramètres décrivant les entrées acceptées.
- **examples** -- Exemples de conversation optionnels pour aider l'agent à apprendre quand utiliser l'action.

Lorsqu'un utilisateur envoie un message, le runtime évalue toutes les actions enregistrées. Si l'agent détermine qu'une action correspond à l'intention de l'utilisateur, il extrait les paramètres de la conversation et appelle le handler.

<div id="built-in-actions-reference">

## Référence des Actions Intégrées

</div>

Eliza enregistre les actions intégrées suivantes depuis `src/actions/` automatiquement à l'exécution.

<div id="agent-lifecycle">

### Cycle de Vie de l'Agent

</div>

**RESTART_AGENT** -- Redémarre gracieusement le processus de l'agent. Arrête le runtime, reconstruit si les fichiers source ont changé, et relance. Persiste une mémoire "Restarting...", retourne la réponse, puis planifie un redémarrage après un délai de 1,5 seconde pour que la réponse puisse être vidée. En mode CLI, sort avec le code 75 pour le script d'exécution ; en mode runtime de bureau, effectue un redémarrage à chaud dans le processus. Le paramètre optionnel `reason` est enregistré pour les diagnostics.

<div id="plugin-management">

### Gestion des Plugins

</div>

Ces actions fournissent un flux de travail complet d'éjection de plugins. "Éjecter" clone le code source d'un plugin localement pour que le runtime charge votre copie locale au lieu du paquet npm.

| Action | Description | Paramètres Clés |
|--------|-------------|----------------|
| `EJECT_PLUGIN` | Clone le code source d'un plugin localement pour que les modifications remplacent la version npm. Déclenche un redémarrage. | `pluginId` (requis) |
| `SYNC_PLUGIN` | Récupère et fusionne les commits upstream dans un plugin éjecté. Signale les conflits s'il y en a. | `pluginId` (requis) |
| `REINJECT_PLUGIN` | Supprime la copie éjectée du plugin pour que le runtime revienne à npm. Déclenche un redémarrage. | `pluginId` (requis) |
| `LIST_EJECTED_PLUGINS` | Liste tous les plugins éjectés avec le nom, la branche et le chemin local. | Aucun |

<div id="core-ejection">

### Éjection du Noyau

</div>

Similaire à l'éjection de plugins mais pour le framework noyau elizaOS lui-même.

| Action | Description |
|--------|-------------|
| `EJECT_CORE` | Clone le code source de `@elizaos/core` localement pour que les modifications remplacent le paquet npm. Déclenche un redémarrage. |
| `SYNC_CORE` | Synchronise un checkout éjecté du noyau avec l'upstream et le reconstruit. Signale le nombre de commits upstream ou les conflits. |
| `REINJECT_CORE` | Supprime le code source éjecté du noyau pour que le runtime revienne au paquet npm `@elizaos/core`. Déclenche un redémarrage. |
| `CORE_STATUS` | Affiche si `@elizaos/core` s'exécute depuis npm ou depuis le code source éjecté, avec la version et le hash de commit. |

<div id="communication">

### Communication

</div>

**MESSAGE** -- Envoie un message à un utilisateur ou une salle sur une plateforme/service spécifique. Nécessite `targetType` (`user` ou `room`), `source` (nom du service comme `telegram`), `target` (ID d'entité/salle), et `text`. Recherche le service via `runtime.getService()` et appelle la méthode d'envoi appropriée.

<div id="media-generation">

### Génération de Médias

</div>

| Action | Description | Paramètres Requis |
|--------|-------------|------------------|
| `GENERATE_MEDIA` | Génère une image, une vidéo ou de l'audio à partir d'un prompt textuel. Supporte les options d'image, de vidéo et d'audio; utilisez `mediaType` pour forcer `image`, `video` ou `audio`. | `prompt` |
| `ANALYZE_IMAGE` | Analyse une image en utilisant la vision IA. Accepte `imageUrl` ou `imageBase64` avec un `prompt` d'analyse optionnel. | `imageUrl` ou `imageBase64` |

Toutes les actions de médias utilisent le fournisseur configuré (Eliza Cloud par défaut, ou FAL/OpenAI/Google/Anthropic).

<div id="system">

### Système

</div>

| Action | Description |
|--------|-------------|
| `PLAY_EMOTE` | Joue une animation d'emote sur l'avatar. Recherche l'emote dans le catalogue et effectue un POST vers l'API locale. |
| `INSTALL_PLUGIN` | Installe un plugin depuis le registre via `POST /api/plugins/install`. Redémarre automatiquement pour le charger. |
| `SHELL_COMMAND` | Exécute une commande shell via `POST /api/terminal/run`. La sortie est diffusée par WebSocket. |
| `LOG_LEVEL` | Définit le niveau de log par salle pour la session actuelle (`trace`, `debug`, `info`, `warn`, `error`). |

<div id="custom-actions">

## Actions Personnalisées

</div>

Les actions personnalisées sont des capacités définies par l'utilisateur dans votre configuration `eliza.json`. Elles vous permettent de connecter des APIs externes, d'exécuter des commandes shell ou d'exécuter du JavaScript en ligne -- le tout présenté comme des actions de première classe que l'agent peut invoquer pendant les conversations.

<div id="handler-types">

### Types de Handler

</div>

Chaque action personnalisée possède un `handler` qui spécifie comment elle s'exécute :

<CodeGroup>
```json http
{
  "type": "http",
  "method": "POST",
  "url": "https://api.example.com/data/{{query}}",
  "headers": {
    "Authorization": "Bearer sk-xxx",
    "Content-Type": "application/json"
  },
  "bodyTemplate": "{\"search\": \"{{query}}\"}"
}
```

```json shell
{
  "type": "shell",
  "command": "curl -s https://api.example.com/status?q={{query}}"
}
```

```json code
{
  "type": "code",
  "code": "const res = await fetch('https://api.example.com/data/' + params.id); return await res.text();"
}
```
</CodeGroup>

**`http`** -- Effectue une requête HTTP. Les marqueurs de paramètres (`{{paramName}}`) dans l'URL sont encodés en URI ; les marqueurs dans le modèle de corps sont laissés bruts pour les contextes JSON. Champs : `method`, `url`, `headers`, `bodyTemplate`.

<Warning>
Les handlers HTTP incluent une protection SSRF qui bloque les requêtes vers les adresses réseau privées/internes (localhost, link-local, plages RFC-1918, endpoints de métadonnées cloud). La résolution DNS est vérifiée pour empêcher les contournements par alias. Les redirections sont entièrement bloquées.
</Warning>

**`shell`** -- Exécute une commande shell via l'API de terminal locale. Les valeurs des paramètres sont automatiquement échappées pour prévenir l'injection. S'exécute via `POST /api/terminal/run`.

**`code`** -- Exécute du JavaScript en ligne dans un contexte VM Node.js isolé (`vm.runInNewContext()`). Seuls `params` et `fetch` sont exposés dans le sandbox -- pas d'accès à `require`, `import`, `process` ni `global`. Délai d'expiration de 30 secondes.

<div id="customactiondef-schema">

### Schéma CustomActionDef

</div>

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | `string` | Oui | Identifiant unique pour l'action |
| `name` | `string` | Oui | Nom de l'action utilisé par l'agent pour l'invoquer |
| `description` | `string` | Oui | Description lisible de ce que fait l'action |
| `similes` | `string[]` | Non | Noms/déclencheurs alternatifs pour l'action |
| `parameters` | `Array<{name, description, required}>` | Oui | Définitions des paramètres |
| `handler` | `CustomActionHandler` | Oui | Un des objets handler `http`, `shell` ou `code` |
| `enabled` | `boolean` | Oui | Si l'action est active |
| `createdAt` | `string` | Oui | Horodatage ISO de création |
| `updatedAt` | `string` | Oui | Horodatage ISO de la dernière mise à jour |

<div id="defining-custom-actions">

### Définir des Actions Personnalisées

</div>

Ajoutez des actions personnalisées au tableau `customActions` dans votre `eliza.json` :

```json
{
  "customActions": [
    {
      "id": "weather-check",
      "name": "CHECK_WEATHER",
      "description": "Check the current weather for a given city",
      "similes": ["WEATHER", "GET_WEATHER", "FORECAST"],
      "parameters": [
        {
          "name": "city",
          "description": "The city name to check weather for",
          "required": true
        }
      ],
      "handler": {
        "type": "http",
        "method": "GET",
        "url": "https://wttr.in/{{city}}?format=3"
      },
      "enabled": true,
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

<div id="action-discovery-and-registration">

### Découverte et Enregistrement des Actions

</div>

**Chargement au démarrage :** Lors de l'initialisation du plugin, `loadCustomActions()` lit `eliza.json`, filtre uniquement les définitions avec `enabled`, et convertit chacune en une `Action` elizaOS via `defToAction()`. La conversion construit un handler asynchrone basé sur le type de handler, mappe les paramètres au format elizaOS (tous typés comme `string`), et définit `validate: async () => true`.

**Enregistrement en direct :** Enregistrez de nouvelles actions à l'exécution sans redémarrer en utilisant `registerCustomActionLive(def)`. Cela convertit la définition en utilisant le même pipeline `defToAction()` et appelle `runtime.registerAction()` pour la rendre immédiatement disponible. Retourne l'`Action` créée ou `null` si aucun runtime n'est disponible.

**Tests :** La fonction `buildTestHandler(def)` crée un handler temporaire pour les tests sans enregistrement. Retourne une fonction qui accepte des paramètres et retourne `{ ok: boolean; output: string }`.

```typescript
import { buildTestHandler } from './runtime/custom-actions';

const testHandler = buildTestHandler(myActionDef);
const result = await testHandler({ city: 'London' });
// result: { ok: true, output: 'London: +12°C' }
```

<div id="creating-actions-in-plugins">

## Créer des Actions dans les Plugins

</div>

Au-delà des actions personnalisées définies par configuration, vous pouvez créer des actions dans un plugin en implémentant directement l'interface `Action`.

<Steps>

<div id="define-the-action">

### Définir l'Action

</div>

```typescript
import type { Action, HandlerOptions } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_CUSTOM_ACTION',
  similes: ['MY_ACTION', 'DO_THING'],
  description: 'Describe what this action does so the agent knows when to use it.',

  validate: async (runtime, message, state) => {
    // Return true if this action can run in the current context.
    return true;
  },

  handler: async (runtime, message, state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const input = typeof params?.input === 'string' ? params.input.trim() : '';

    if (!input) {
      return { text: 'I need an input parameter.', success: false };
    }

    const result = await doSomething(input);
    return {
      text: `Done: ${result}`,
      success: true,
      data: { input, result },
    };
  },

  parameters: [
    {
      name: 'input',
      description: 'The input value for this action',
      required: true,
      schema: { type: 'string' as const },
    },
  ],
};
```

<div id="write-the-validation-function">

### Écrire la Fonction de Validation

</div>

Modèles de validation courants :

```typescript
// Toujours disponible
validate: async () => true,

// Seulement quand un service spécifique est chargé
validate: async (runtime) => {
  return runtime.getService('myservice') !== null;
},

// Seulement pour certains utilisateurs
validate: async (runtime, message) => {
  const adminIds = ['user-123', 'user-456'];
  return adminIds.includes(message.entityId);
},
```

<div id="write-the-handler-function">

### Écrire la Fonction Handler

</div>

Le handler reçoit `runtime` (IAgentRuntime), `message` (Memory), `state` (State | undefined), et `options` (converti en `HandlerOptions` pour l'accès aux paramètres). Il doit retourner un objet avec `text` (string) et `success` (boolean). Champs optionnels : `data` (métadonnées) et `attachments` (fichiers médias).

<div id="register-in-a-plugin">

### Enregistrer dans un Plugin

</div>

```typescript
import type { Plugin } from '@elizaos/core';
import { myAction } from './actions/my-action';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin',
  actions: [myAction],
};
```

</Steps>

<div id="action-execution-flow">

## Flux d'Exécution des Actions

</div>

Lorsque l'agent traite un message, les actions sont évaluées dans cet ordre :

1. **Correspondance d'intention** -- Le runtime évalue les noms, similes et descriptions de toutes les actions enregistrées par rapport au contexte de la conversation.
2. **Validation** -- La fonction `validate()` de l'action sélectionnée est appelée. Si elle retourne `false`, l'action est ignorée.
3. **Extraction des paramètres** -- Le runtime extrait les valeurs des paramètres de la conversation en se basant sur les définitions de `parameters` de l'action.
4. **Exécution du handler** -- Le `handler()` de l'action s'exécute avec les paramètres extraits.
5. **Livraison de la réponse** -- La valeur de retour du handler (texte, pièces jointes, données) est livrée à l'utilisateur.

<div id="best-practices">

## Bonnes Pratiques

</div>

<Info>

**Nommage :** Utilisez SCREAMING_SNAKE_CASE pour les noms des actions. Gardez les noms courts et ajoutez des similes pertinents pour améliorer la correspondance d'intention.

**Descriptions :** L'agent utilise la description pour décider quand invoquer votre action. Rédigez des descriptions claires et spécifiques qui expliquent à la fois ce que fait l'action et quand elle doit être utilisée.

**Validez défensivement :** Vérifiez toujours les paramètres requis dans le handler et retournez un message d'erreur utile s'ils sont manquants, même si `validate()` retourne `true`.

**Gardez les handlers rapides :** Pour les opérations longues, retournez un message de statut immédiatement et utilisez WebSocket ou le polling pour les mises à jour de progression.

**Retours structurés :** Incluez toujours `success: boolean`. Utilisez `data` pour les métadonnées lisibles par machine que d'autres actions ou l'UI peuvent consommer.

</Info>
