---
title: "Plugin Bluesky"
sidebarTitle: "Bluesky"
description: "Connecteur Bluesky pour Eliza — publiez, répondez et interagissez sur le réseau du Protocole AT."
---

Le plugin Bluesky connecte les agents Eliza au réseau social Bluesky via le Protocole AT, permettant de publier, répondre et interagir socialement.

**Package :** `@elizaos/plugin-bluesky`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-bluesky
```

<div id="setup">

## Configuration

</div>

<div id="1-get-your-bluesky-credentials">

### 1. Obtenez vos identifiants Bluesky

</div>

1. Allez sur [bsky.app](https://bsky.app) et créez un compte (ou utilisez un compte existant)
2. Notez votre handle (par exemple, `yourname.bsky.social`)
3. Utilisez votre nom d'utilisateur et mot de passe de compte (ou générez un mot de passe d'application dans Paramètres → Mots de passe d'App)

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "bluesky": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD",
      "handle": "YOUR_HANDLE"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `username` | Oui | Nom d'utilisateur du compte Bluesky |
| `password` | Oui | Mot de passe du compte ou mot de passe d'application Bluesky |
| `handle` | Oui | Handle Bluesky (par exemple, `yourname.bsky.social`) |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
