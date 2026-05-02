---
title: "Plugin GitHub"
sidebarTitle: "GitHub"
description: "Connecteur GitHub pour Eliza — interagissez avec les dépôts, les issues et les pull requests."
---

Le plugin GitHub connecte les agents Eliza à GitHub, permettant les interactions avec les dépôts, les issues, les pull requests et d'autres ressources GitHub.

**Package :** `@elizaos/plugin-github`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-github
```

<div id="setup">

## Configuration

</div>

<div id="1-create-a-github-personal-access-token">

### 1. Créez un token d'accès personnel GitHub

</div>

1. Allez sur [github.com/settings/tokens](https://github.com/settings/tokens)
2. Cliquez sur **Generate new token** (classique) ou **Fine-grained token**
3. Sélectionnez les permissions nécessaires pour votre cas d'usage (par exemple, `repo`, `issues`, `pull_requests`)
4. Copiez le token généré

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "github": {
      "apiToken": "YOUR_API_TOKEN",
      "owner": "YOUR_GITHUB_OWNER",
      "repo": "YOUR_GITHUB_REPO"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `apiToken` | Oui | Token d'accès personnel GitHub |
| `owner` | Oui | Propriétaire du dépôt GitHub (utilisateur ou organisation) |
| `repo` | Oui | Nom du dépôt GitHub |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
