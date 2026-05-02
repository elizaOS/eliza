---
title: "Plugin Instagram"
sidebarTitle: "Instagram"
description: "Connecteur Instagram pour Eliza — interagissez avec la messagerie et le contenu Instagram."
---

Le plugin Instagram connecte les agents Eliza à Instagram, permettant la gestion des messages et les interactions de contenu.

**Package :** `@elizaos/plugin-instagram`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-instagram
```

<div id="setup">

## Configuration

</div>

<div id="1-get-your-instagram-credentials">

### 1. Obtenez vos identifiants Instagram

</div>

1. Utilisez votre nom d'utilisateur et mot de passe de compte Instagram
2. Pour l'automatisation, envisagez de créer un compte dédié pour votre agent

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "instagram": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `username` | Oui | Nom d'utilisateur du compte Instagram |
| `password` | Oui | Mot de passe du compte Instagram |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
