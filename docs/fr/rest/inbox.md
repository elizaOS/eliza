---
title: "API Boîte de réception"
sidebarTitle: "Boîte de réception"
description: "Endpoints de l'API REST pour la boîte de réception unifiée multicanal — messages agrégés, fils de discussion et découverte des sources."
---

L'API de boîte de réception fournit une vue en lecture seule, ordonnée chronologiquement, des messages de tous les canaux de connecteurs auxquels l'agent participe — iMessage, Telegram, Discord, WhatsApp, WeChat, Slack, Signal et SMS — fusionnés dans un flux unique. Les messages du chat web du tableau de bord sont exclus, car ils sont déjà accessibles via l'[API de conversations](/fr/rest/conversations).

<div id="endpoints">

## Endpoints

</div>

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/inbox/messages` | Lister les messages récents de tous les canaux de connecteurs |
| GET | `/api/inbox/chats` | Lister les fils de discussion des connecteurs (une ligne par salon) |
| GET | `/api/inbox/sources` | Lister les tags de source de connecteurs distincts |

---

<div id="get-apiinboxmessages">

### GET /api/inbox/messages

</div>

Liste les messages les plus récents de tous les canaux de connecteurs dans un flux unifié, ordonné chronologiquement (les plus récents en premier).

**Paramètres de requête**

| Paramètre | Type | Requis | Par défaut | Description |
|-----------|------|--------|------------|-------------|
| `limit` | integer | Non | 100 | Nombre maximum de messages à retourner (plafond de 500) |
| `sources` | string | Non | Toutes les sources de la boîte de réception | Filtre de sources séparées par des virgules (ex. `discord,telegram`) |
| `roomId` | string | Non | — | Limiter à un seul ID de salon pour les vues au niveau du fil |

**Réponse**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hey, check this out!",
      "timestamp": 1718000000000,
      "source": "discord",
      "roomId": "room-uuid",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ],
  "count": 1
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `messages[].id` | string | UUID de mémoire |
| `messages[].role` | string | `user` ou `assistant` |
| `messages[].text` | string | Contenu textuel du message |
| `messages[].timestamp` | number | Horodatage Unix (ms) de la création du message |
| `messages[].source` | string | Tag de source du connecteur (ex. `imessage`, `telegram`, `discord`) |
| `messages[].roomId` | string | ID de salon de chat externe pour le regroupement en fils |
| `messages[].from` | string\|undefined | Nom d'affichage de l'expéditeur (meilleur effort) |
| `messages[].fromUserName` | string\|undefined | Nom d'utilisateur ou identifiant de l'expéditeur (ex. nom d'utilisateur Discord) |
| `messages[].avatarUrl` | string\|undefined | URL de l'avatar de l'expéditeur lorsque le connecteur le fournit |

Pour les messages Discord, `from`, `fromUserName` et `avatarUrl` sont enrichis à partir du profil utilisateur Discord en temps réel lorsqu'il est disponible.

---

<div id="get-apiinboxchats">

### GET /api/inbox/chats

</div>

Liste les fils de discussion des connecteurs — une ligne par salon de chat externe. Utilisé par la barre latérale pour afficher une liste de chats unifiée aux côtés des conversations du tableau de bord.

**Paramètres de requête**

| Paramètre | Type | Requis | Par défaut | Description |
|-----------|------|--------|------------|-------------|
| `sources` | string | Non | Toutes les sources de la boîte de réception | Filtre de sources séparées par des virgules |

**Réponse**

```json
{
  "chats": [
    {
      "id": "room-uuid",
      "source": "discord",
      "title": "#general",
      "lastMessageText": "Hey, check this out!",
      "lastMessageAt": 1718000000000,
      "messageCount": 42
    }
  ],
  "count": 1
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `chats[].id` | string | ID de salon (stable entre les interrogations, utilisé comme clé de sélection) |
| `chats[].source` | string | Tag de source du connecteur pour le rendu des badges |
| `chats[].title` | string | Titre d'affichage — nom du canal, nom du contact pour les messages directs, ou repli `"<source> chat"` |
| `chats[].lastMessageText` | string | Aperçu du message le plus récent (tronqué à 140 caractères) |
| `chats[].lastMessageAt` | number | Horodatage en ms epoch du message le plus récent |
| `chats[].messageCount` | number | Total des messages dans ce salon au moment de l'analyse |

Les titres des chats sont résolus dans l'ordre de priorité suivant :

1. Nom du canal Discord en temps réel (récupéré depuis le client Discord pour les sources Discord)
2. Nom de salon enregistré (défini par le plugin du connecteur lors de la création du salon)
3. Nom du dernier expéditeur (pour les salons de messages directs)
4. Repli : `"<source> chat"`

---

<div id="get-apiinboxsources">

### GET /api/inbox/sources

</div>

Liste l'ensemble distinct des tags de source de connecteurs pour lesquels l'agent possède actuellement des messages. Utilisez ceci pour construire des chips de filtre de source dynamiques dans l'interface sans coder en dur les noms des connecteurs.

**Réponse**

```json
{
  "sources": ["imessage", "telegram", "discord", "whatsapp"]
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `sources` | string[] | Tableau de tags de source distincts présents dans l'historique des messages de l'agent |

<div id="supported-sources">

## Sources supportées

</div>

La boîte de réception inclut les messages de ces sources de connecteurs par défaut :

| Tag de source | Plateforme |
|---------------|------------|
| `imessage` | iMessage |
| `telegram` | Telegram |
| `discord` | Discord |
| `whatsapp` | WhatsApp |
| `wechat` | WeChat |
| `slack` | Slack |
| `signal` | Signal |
| `sms` | SMS |

Les messages provenant de `client_chat` (chat web du tableau de bord) et des sources internes (événements système, ingestion de connaissances) sont exclus du flux de la boîte de réception.

<div id="common-error-codes">

## Codes d'erreur courants

</div>

| Statut | Code | Description |
|--------|------|-------------|
| 500 | `INTERNAL_ERROR` | Échec du chargement des données de la boîte de réception |
