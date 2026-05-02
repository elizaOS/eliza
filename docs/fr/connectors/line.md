---
title: Connecteur LINE
sidebarTitle: LINE
description: Connectez votre agent à LINE en utilisant le package @elizaos/plugin-line.
---

Connectez votre agent à LINE pour la messagerie bot et les conversations clients.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur LINE est un plugin elizaOS qui relie votre agent à l'API de messagerie LINE. Il prend en charge les types de messages enrichis, le chat de groupe et la gestion d'événements par webhooks. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-line` |
| Clé de configuration | `connectors.line` |
| Installation | `eliza plugins install @elizaos/plugin-line` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Token d'accès de canal LINE
- Secret de canal LINE
- Créez un canal Messaging API sur [developers.line.biz](https://developers.line.biz)

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "line": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## Variables d'environnement

</div>

| Variable | Description |
|----------|-------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Token d'accès du canal depuis la Console Développeur LINE |
| `LINE_CHANNEL_SECRET` | Secret du canal pour la vérification des webhooks |
| `LINE_CUSTOM_GREETING` | Message d'accueil personnalisé pour les nouveaux utilisateurs |

<div id="features">

## Fonctionnalités

</div>

- Messagerie bot et conversations clients
- Types de messages enrichis (texte, sticker, image, vidéo)
- Support du chat de groupe
- Gestion d'événements par webhooks

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#line)
