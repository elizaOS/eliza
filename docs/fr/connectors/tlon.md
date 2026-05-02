---
title: Connecteur Tlon
sidebarTitle: Tlon
description: Connectez votre agent à Tlon/Urbit en utilisant le package @elizaos/plugin-tlon.
---

Connectez votre agent au réseau Urbit via Tlon pour la messagerie ship-to-ship.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Tlon est un plugin elizaOS qui relie votre agent au réseau Urbit. Il prend en charge la messagerie ship-to-ship et la participation aux chats de groupe. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-tlon` |
| Clé de configuration | `connectors.tlon` |
| Installation | `eliza plugins install @elizaos/plugin-tlon` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Identifiants du ship Tlon (nom du ship Urbit et code d'accès)

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "tlon": {
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
| `TLON_SHIP` | Nom du ship Urbit |
| `TLON_CODE` | Code d'accès du ship |
| `TLON_URL` | URL du ship |

<div id="features">

## Fonctionnalités

</div>

- Chat et interactions sociales basés sur Urbit
- Messagerie ship-to-ship
- Participation aux chats de groupe

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#tlon)
