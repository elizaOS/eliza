---
title: Connecteur Instagram
sidebarTitle: Instagram
description: Connectez votre agent à Instagram en utilisant le package @elizaos/plugin-instagram.
---

Connectez votre agent à Instagram pour la publication de médias, la surveillance des commentaires et la gestion des messages directs.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Instagram est un plugin elizaOS qui relie votre agent à Instagram. Il prend en charge la publication de médias avec génération de légendes, la réponse aux commentaires et la gestion des messages directs. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-instagram` |
| Clé de configuration | `connectors.instagram` |
| Installation | `eliza plugins install @elizaos/plugin-instagram` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Identifiants de compte Instagram (nom d'utilisateur et mot de passe)

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "instagram": {
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
| `INSTAGRAM_USERNAME` | Nom d'utilisateur Instagram |
| `INSTAGRAM_PASSWORD` | Mot de passe Instagram |
| `INSTAGRAM_DRY_RUN` | Définir à `true` pour tester sans publier |
| `INSTAGRAM_POLL_INTERVAL` | Intervalle de sondage en ms |
| `INSTAGRAM_POST_INTERVAL_MIN` | Secondes minimum entre les publications |
| `INSTAGRAM_POST_INTERVAL_MAX` | Secondes maximum entre les publications |

<div id="features">

## Fonctionnalités

</div>

- Publication de médias avec génération de légendes
- Surveillance et réponse aux commentaires
- Gestion des messages directs
- Mode test sans publication
- Intervalles de publication et de sondage configurables

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#instagram)
