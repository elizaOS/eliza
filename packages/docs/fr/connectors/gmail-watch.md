---
title: Connecteur Gmail Watch
sidebarTitle: Gmail Watch
description: Surveillez les boîtes de réception Gmail en utilisant le package @elizaos/plugin-gmail-watch.
---

Surveillez les boîtes de réception Gmail pour les messages entrants via Pub/Sub.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Gmail Watch est un plugin elizaOS qui surveille les boîtes de réception Gmail via Google Cloud Pub/Sub. Il détecte les nouveaux messages et déclenche des événements d'agent. Ce connecteur est activé via des feature flags plutôt que la section `connectors`. Disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-gmail-watch` |
| Feature flag | `features.gmailWatch` |
| Installation | `eliza plugins install @elizaos/plugin-gmail-watch` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Compte de service Google Cloud ou identifiants OAuth avec accès à l'API Gmail
- Sujet Pub/Sub configuré pour les notifications push Gmail

<div id="configuration">

## Configuration

</div>

Gmail Watch se configure à deux endroits dans `eliza.json` :

### 1. Activer via le feature flag

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

### 2. Configurer le compte Gmail dans hooks

```json
{
  "hooks": {
    "gmail": {
      "account": "user@gmail.com",
      "label": "INBOX",
      "includeBody": true
    }
  }
}
```

### Exemple complet

```json
{
  "features": {
    "gmailWatch": true
  },
  "hooks": {
    "enabled": true,
    "gmail": {
      "account": "user@gmail.com",
      "label": "INBOX",
      "includeBody": true
    }
  }
}
```

### Champs de configuration Gmail

| Champ | Type | Par défaut | Description |
|-------|------|------------|-------------|
| `account` | string | — | Adresse Gmail à surveiller (requis) |
| `label` | string | `"INBOX"` | Libellé Gmail à surveiller |
| `includeBody` | boolean | `false` | Inclure le corps de l'email dans les événements de l'agent |

<div id="features">

## Fonctionnalités

</div>

- Surveillance des messages Gmail via Pub/Sub
- Renouvellement automatique des abonnements de surveillance
- Gestion des événements d'emails entrants
- Filtrage par libellé pour la surveillance ciblée de la boîte de réception

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#gmail-watch)
