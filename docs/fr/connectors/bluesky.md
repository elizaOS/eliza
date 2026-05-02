---
title: Connecteur Bluesky
sidebarTitle: Bluesky
description: Connectez votre agent à Bluesky en utilisant le package @elizaos/plugin-bluesky.
---

Connectez votre agent à Bluesky pour les publications sociales et l'engagement sur le réseau du Protocole AT.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Bluesky est un plugin elizaOS qui relie votre agent à Bluesky via le Protocole AT. Il prend en charge la publication automatisée, la surveillance des mentions et la gestion des réponses.

Contrairement aux 18 connecteurs auto-activés (Discord, Telegram, etc.), Bluesky est un **plugin de registre** qui doit être installé manuellement avant utilisation. Il ne s'active pas automatiquement à partir de la seule configuration du connecteur.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-bluesky` |
| Clé de configuration | `connectors.bluesky` |
| Installation | `eliza plugins install @elizaos/plugin-bluesky` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Identifiants de compte Bluesky (handle et mot de passe d'application)
- Générez un mot de passe d'application sur [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

<div id="environment-variables">

## Variables d'environnement

</div>

| Variable | Description |
|----------|-------------|
| `BLUESKY_USERNAME` | Nom d'utilisateur/email Bluesky |
| `BLUESKY_PASSWORD` | Mot de passe d'application (pas votre mot de passe principal) |
| `BLUESKY_HANDLE` | Handle Bluesky (par exemple, `yourname.bsky.social`) |
| `BLUESKY_ENABLED` | Définir à `true` pour activer |
| `BLUESKY_DRY_RUN` | Définir à `true` pour tester sans publier |

<div id="features">

## Fonctionnalités

</div>

- Création de publications à intervalles configurables
- Surveillance des mentions et des réponses
- Mode test sans publication
- Réseau social décentralisé basé sur le Protocole AT

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#bluesky)
