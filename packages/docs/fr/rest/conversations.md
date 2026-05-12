---
title: "API des Conversations"
sidebarTitle: "Conversations"
description: "Endpoints de l'API REST pour la gestion des conversations de chat web — CRUD, messagerie et streaming."
---

L'API des conversations gère l'interface de chat web de l'agent. Chaque conversation dispose de sa propre salle dans le système de mémoire du runtime, permettant des historiques de messages indépendants. L'API prend en charge la livraison de messages en streaming (SSE) et synchrone.

<div id="endpoints">

## Endpoints

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/conversations` | Lister toutes les conversations |
| POST | `/api/conversations` | Créer une nouvelle conversation |
| GET | `/api/conversations/:id/messages` | Obtenir les messages d'une conversation |
| POST | `/api/conversations/:id/messages` | Envoyer un message (synchrone) |
| POST | `/api/conversations/:id/messages/stream` | Envoyer un message (streaming SSE) |
| POST | `/api/conversations/:id/greeting` | Générer un message d'accueil |
| PATCH | `/api/conversations/:id` | Mettre à jour les métadonnées de la conversation |
| DELETE | `/api/conversations/:id` | Supprimer une conversation |

---

<div id="get-apiconversations">

### GET /api/conversations

</div>

Liste toutes les conversations, triées par la plus récemment mise à jour en premier.

**Réponse**

```json
{
  "conversations": [
    {
      "id": "uuid",
      "title": "Morning Chat",
      "roomId": "uuid",
      "createdAt": "2025-06-01T10:00:00.000Z",
      "updatedAt": "2025-06-01T12:30:00.000Z"
    }
  ]
}
```

---

<div id="post-apiconversations">

### POST /api/conversations

</div>

Crée une nouvelle conversation avec sa propre salle.

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `title` | string | Non | Titre de la conversation (par défaut `"New Chat"`) |

**Réponse**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "New Chat",
    "roomId": "uuid",
    "createdAt": "2025-06-01T12:00:00.000Z",
    "updatedAt": "2025-06-01T12:00:00.000Z"
  }
}
```

---

<div id="get-apiconversationsidmessages">

### GET /api/conversations/:id/messages

</div>

Récupère jusqu'à 200 messages d'une conversation, triés du plus ancien au plus récent. Les messages avec un contenu texte vide (comme les mémoires de journal d'actions) sont automatiquement filtrés.

**Réponse**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hello!",
      "timestamp": 1718000000000
    },
    {
      "id": "uuid",
      "role": "assistant",
      "text": "Hey there! How can I help?",
      "timestamp": 1718000001000
    },
    {
      "id": "uuid",
      "role": "user",
      "text": "What's going on in Discord?",
      "timestamp": 1718000002000,
      "source": "discord",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ]
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `messages[].role` | string | `user` ou `assistant` |
| `messages[].text` | string | Contenu texte du message |
| `messages[].timestamp` | number | Horodatage Unix (ms) de la création du message |
| `messages[].source` | string\|undefined | Identifiant de source du connecteur (p. ex. `discord`, `telegram`). Omis pour les messages de chat web |
| `messages[].from` | string\|undefined | Nom d'affichage de l'entité émettrice, lorsque disponible |
| `messages[].fromUserName` | string\|undefined | Nom d'utilisateur ou identifiant de l'expéditeur (p. ex. nom d'utilisateur Discord), lorsque le connecteur en fournit un |
| `messages[].avatarUrl` | string\|undefined | URL de l'avatar de l'expéditeur lorsque le connecteur peut en fournir un |

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 404 | Conversation non trouvée |

---

<div id="post-apiconversationsidmessages">

### POST /api/conversations/:id/messages

</div>

Envoie un message et obtient la réponse de l'agent de manière synchrone (sans streaming).

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `text` | string | Oui | Texte du message de l'utilisateur |
| `channelType` | string | Non | Remplacement du type de canal |
| `images` | array | Non | Données d'images jointes |

**Réponse**

```json
{
  "text": "Here's what I think...",
  "agentName": "Eliza"
}
```

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 404 | Conversation non trouvée |
| 503 | L'agent n'est pas en cours d'exécution |

---

<div id="post-apiconversationsidmessagesstream">

### POST /api/conversations/:id/messages/stream

</div>

Envoie un message et reçoit la réponse de l'agent via Server-Sent Events (SSE). Chaque token est transmis au fur et à mesure de sa génération, suivi d'un événement final `done`.

**Corps de la requête**

Identique à `POST /api/conversations/:id/messages`.

**Événements SSE**

Événements de token (sémantique d'ajout — chaque fragment de texte étend la réponse) :
```
data: {"type":"token","text":"Here's"}
data: {"type":"token","text":" what"}
data: {"type":"token","text":" I think..."}
```

Événements d'instantané (sémantique de remplacement — utilisés lorsque les callbacks d'actions mettent à jour la réponse en place) :
```
data: {"type":"token","fullText":"Here's what I think...\n\nSearching for track..."}
```

Lorsqu'un champ `fullText` est présent, il fait autorité et le client doit remplacer l'intégralité du texte du message de l'assistant plutôt que de l'ajouter.

Événement final :
```
data: {"type":"done","fullText":"Here's what I think...","agentName":"Eliza"}
```

Le titre de la conversation est généré automatiquement en arrière-plan s'il est encore `"New Chat"`, et un événement WebSocket `conversation-updated` est diffusé. Si la génération de titre par IA échoue, le titre se rabat sur les cinq premiers mots du message de l'utilisateur.

<Info>
Les callbacks d'actions (p. ex. lecture de musique, flux de portefeuille) utilisent la sémantique de **remplacement** : chaque callback successif remplace la portion du callback du message plutôt que de l'ajouter. Cela correspond au modèle de message progressif utilisé sur Discord et Telegram. Voir [Callbacks d'actions et streaming SSE](/fr/runtime/action-callback-streaming) pour plus de détails.
</Info>

---

<div id="post-apiconversationsidgreeting">

### POST /api/conversations/:id/greeting

</div>

Génère un message d'accueil pour une nouvelle conversation. Sélectionne un `postExample` aléatoire à partir de la définition de caractère de l'agent — pas d'appel au modèle, pas de latence. Le message d'accueil est stocké comme message de l'agent pour la persistance.

**Réponse**

```json
{
  "text": "gm. ready to go viral today or what.",
  "agentName": "Eliza",
  "generated": true
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `text` | string | Le texte d'accueil (vide si aucun exemple de publication n'existe) |
| `agentName` | string | Nom d'affichage de l'agent |
| `generated` | boolean | `true` si des exemples de publication étaient disponibles |

---

<div id="patch-apiconversationsid">

### PATCH /api/conversations/:id

</div>

Met à jour les métadonnées de la conversation (prend actuellement en charge le renommage).

**Corps de la requête**

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `title` | string | Non | Nouveau titre de la conversation |

**Réponse**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "Updated Title",
    "roomId": "uuid",
    "createdAt": "2025-06-01T10:00:00.000Z",
    "updatedAt": "2025-06-01T14:00:00.000Z"
  }
}
```

**Erreurs**

| Statut | Condition |
|--------|-----------|
| 404 | Conversation non trouvée |

---

<div id="delete-apiconversationsid">

### DELETE /api/conversations/:id

</div>

Supprime une conversation. Les messages restent dans la mémoire du runtime, mais les métadonnées de la conversation sont supprimées.

**Réponse**

```json
{
  "ok": true
}
```


<div id="common-error-codes">

## Codes d'erreur courants

</div>

| Statut | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Le corps de la requête est malformé ou des champs requis sont manquants |
| 401 | `UNAUTHORIZED` | Token d'authentification manquant ou invalide |
| 404 | `NOT_FOUND` | La ressource demandée n'existe pas |
| 404 | `CONVERSATION_NOT_FOUND` | La conversation avec l'ID spécifié n'existe pas |
| 503 | `SERVICE_UNAVAILABLE` | Le service de l'agent n'est pas en cours d'exécution |
| 500 | `INTERNAL_ERROR` | Erreur serveur inattendue |
