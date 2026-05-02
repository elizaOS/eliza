---
title: Connecteur Nextcloud Talk
sidebarTitle: Nextcloud Talk
description: Connectez votre agent à Nextcloud Talk en utilisant le package @elizaos/plugin-nextcloud-talk.
---

Connectez votre agent à Nextcloud Talk pour la messagerie de collaboration auto-hébergée.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Nextcloud Talk est un plugin elizaOS qui relie votre agent aux salons Nextcloud Talk. Il prend en charge les conversations en messages directs et en groupe sur des instances Nextcloud auto-hébergées. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-nextcloud-talk` |
| Clé de configuration | `connectors.nextcloud-talk` |
| Installation | `eliza plugins install @elizaos/plugin-nextcloud-talk` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Une instance Nextcloud avec l'application Talk activée
- Un secret de bot pour l'authentification des webhooks (configuré dans les paramètres d'administration de Nextcloud Talk)
- Une URL publiquement accessible pour le point de terminaison du webhook

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## Variables d'environnement

</div>

| Variable | Requise | Description |
|----------|---------|-------------|
| `NEXTCLOUD_URL` | Oui | URL de base de votre instance Nextcloud (ex. `https://cloud.example.com`) |
| `NEXTCLOUD_BOT_SECRET` | Oui | Secret du bot pour la vérification de signature du webhook |
| `NEXTCLOUD_WEBHOOK_HOST` | Non | Adresse hôte pour le listener du webhook |
| `NEXTCLOUD_WEBHOOK_PORT` | Non | Port pour le listener du webhook |
| `NEXTCLOUD_WEBHOOK_PATH` | Non | Chemin pour le point de terminaison du webhook |
| `NEXTCLOUD_WEBHOOK_PUBLIC_URL` | Non | URL publique complète du webhook (remplace host/port/path) |
| `NEXTCLOUD_ALLOWED_ROOMS` | Non | Liste de IDs de salons/canaux séparés par des virgules |
| `NEXTCLOUD_ENABLED` | Non | Définir à `true` pour activer (alternative à la config) |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  },
  "env": {
    "NEXTCLOUD_URL": "https://cloud.example.com",
    "NEXTCLOUD_BOT_SECRET": "YOUR_BOT_SECRET",
    "NEXTCLOUD_WEBHOOK_PUBLIC_URL": "https://your-agent.example.com/hooks/nextcloud",
    "NEXTCLOUD_ALLOWED_ROOMS": "general,support"
  }
}
```

<div id="features">

## Fonctionnalités

</div>

- Messagerie par salons Talk
- Support des conversations directes et de groupe
- Livraison de messages basée sur les webhooks avec vérification de signature
- Liste d'autorisation par salon pour contrôler les conversations auxquelles l'agent participe
- Auto-hébergé — toutes les données restent sur votre instance Nextcloud

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#nextcloud-talk)
