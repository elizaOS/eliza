---
title: "Plugin Gmail Watch"
sidebarTitle: "Gmail Watch"
description: "Connecteur Gmail Watch pour Eliza — surveillez les boîtes de réception Gmail et répondez aux emails entrants."
---

Le plugin Gmail Watch connecte les agents Eliza à Gmail, permettant la surveillance des emails entrants et les réponses automatisées.

**Package :** `@elizaos/plugin-gmail-watch`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-gmail-watch
```

<div id="setup">

## Configuration

</div>

<div id="1-enable-the-feature-flag">

### 1. Activez le feature flag

</div>

Le plugin Gmail Watch est activé via le flag `features.gmailWatch` dans votre configuration Eliza :

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="2-configure-gmail-api-access">

### 2. Configurez l'accès à l'API Gmail

</div>

Suivez la configuration de la console Google Cloud pour activer l'API Gmail et obtenir des identifiants OAuth pour votre agent.

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `features.gmailWatch` | Oui | Définir `true` pour activer le plugin Gmail Watch |

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
