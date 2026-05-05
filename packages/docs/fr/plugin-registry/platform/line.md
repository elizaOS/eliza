---
title: "Plugin LINE"
sidebarTitle: "LINE"
description: "Connecteur LINE pour Eliza — intégration de bot avec la plateforme de messagerie LINE."
---

Le plugin LINE connecte les agents Eliza à LINE en tant que bot, permettant la gestion des messages dans les chats et les groupes.

**Package :** `@elizaos/plugin-line`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-line
```

<div id="setup">

## Configuration

</div>

<div id="1-create-a-line-messaging-api-channel">

### 1. Créez un canal LINE Messaging API

</div>

1. Allez sur [LINE Developers Console](https://developers.line.biz/console/)
2. Créez un nouveau fournisseur (ou utilisez un fournisseur existant)
3. Créez un nouveau canal **Messaging API**
4. Sous l'onglet **Messaging API**, émettez un **Channel access token**
5. Notez le **Channel secret** depuis l'onglet **Basic settings**

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "line": {
      "channelAccessToken": "YOUR_CHANNEL_ACCESS_TOKEN",
      "channelSecret": "YOUR_CHANNEL_SECRET"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `channelAccessToken` | Oui | Token d'accès du canal LINE Messaging API |
| `channelSecret` | Oui | Secret du canal LINE |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
