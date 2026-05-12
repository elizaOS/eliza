---
title: "Plugin Nextcloud Talk"
sidebarTitle: "Nextcloud Talk"
description: "Connecteur Nextcloud Talk pour Eliza — intégration de bot avec le chat Nextcloud Talk."
---

Le plugin Nextcloud Talk connecte les agents Eliza à Nextcloud Talk, permettant la gestion des messages dans les conversations Nextcloud Talk.

**Package :** `@elizaos/plugin-nextcloud-talk`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-nextcloud-talk
```

<div id="setup">

## Configuration

</div>

<div id="1-configure-your-nextcloud-instance">

### 1. Configurez votre instance Nextcloud

</div>

1. Assurez-vous que Nextcloud Talk est installé et activé sur votre instance Nextcloud
2. Créez un utilisateur bot ou utilisez un compte existant pour l'agent
3. Notez l'URL du serveur Nextcloud et les identifiants

<div id="2-configure-eliza">

### 2. Configurez Eliza

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

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `connectors.nextcloud-talk` | Oui | Bloc de configuration pour Nextcloud Talk |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
