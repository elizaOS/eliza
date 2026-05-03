---
title: Connecteur Zalo
sidebarTitle: Zalo
description: Connectez votre agent à Zalo en utilisant le package @elizaos/plugin-zalo.
---

Connectez votre agent à Zalo pour la messagerie de Compte Officiel et les workflows de support.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Zalo est un plugin elizaOS qui relie votre agent à la plateforme Zalo via l'API de Compte Officiel. Ce connecteur est disponible dans le registre de plugins. Une variante pour compte personnel est également disponible sous `@elizaos/plugin-zalouser`.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-zalo` |
| Clé de configuration | `connectors.zalo` |
| Installation | `eliza plugins install @elizaos/plugin-zalo` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Token d'accès de Compte Officiel (OA) Zalo

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "zalo": {
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
| `ZALO_ACCESS_TOKEN` | Token d'accès de l'OA |
| `ZALO_REFRESH_TOKEN` | Identifiant de renouvellement de token |
| `ZALO_APP_ID` | ID de l'application |
| `ZALO_SECRET_KEY` | Clé secrète de l'application |

<div id="features">

## Fonctionnalités

</div>

- Messagerie et workflows de support de Compte Officiel
- Gestion de messages par webhooks
- Gestion des interactions clients

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#zalo)
