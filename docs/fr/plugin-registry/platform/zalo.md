---
title: "Plugin Zalo"
sidebarTitle: "Zalo"
description: "Connecteur Zalo pour Eliza — intégration de bot avec la plateforme de messagerie Zalo."
---

Le plugin Zalo connecte les agents Eliza à Zalo, permettant la gestion des messages via l'API de Compte Officiel Zalo.

**Package :** `@elizaos/plugin-zalo`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-zalo
```

<div id="setup">

## Configuration

</div>

<div id="1-create-a-zalo-official-account">

### 1. Créez un Compte Officiel Zalo

</div>

1. Allez sur le [portail développeurs Zalo](https://developers.zalo.me/)
2. Créez une application et obtenez votre App ID et App Secret
3. Générez un token d'accès et un token de rafraîchissement pour l'accès à l'API

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "zalo": {
      "accessToken": "YOUR_ACCESS_TOKEN",
      "refreshToken": "YOUR_REFRESH_TOKEN",
      "appId": "YOUR_APP_ID",
      "appSecret": "YOUR_APP_SECRET"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `accessToken` | Oui | Token d'accès de l'API Zalo |
| `refreshToken` | Oui | Token de rafraîchissement de l'API Zalo |
| `appId` | Oui | ID de l'application Zalo |
| `appSecret` | Oui | Secret de l'application Zalo |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
