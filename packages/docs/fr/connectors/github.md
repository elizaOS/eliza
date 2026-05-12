---
title: Connecteur GitHub
sidebarTitle: GitHub
description: Connectez votre agent à GitHub en utilisant le package @elizaos/plugin-github.
---

Connectez votre agent à GitHub pour la gestion de dépôts, le suivi des issues et les workflows de pull requests.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur GitHub est un plugin elizaOS qui relie votre agent à l'API GitHub. Il prend en charge la gestion de dépôts, le suivi des issues, la création et la revue de pull requests, et la recherche de code. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-github` |
| Clé de configuration | `connectors.github` |
| Installation | `eliza plugins install @elizaos/plugin-github` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Token API GitHub (token d'accès personnel ou token à granularité fine)

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "github": {
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
| `GITHUB_API_TOKEN` | Token d'accès personnel ou token à granularité fine |
| `GITHUB_OWNER` | Propriétaire du dépôt par défaut |
| `GITHUB_REPO` | Nom du dépôt par défaut |

<div id="features">

## Fonctionnalités

</div>

- Gestion de dépôts
- Suivi et création d'issues
- Workflows de pull requests (créer, réviser, fusionner)
- Recherche de code et accès aux fichiers

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#github)
