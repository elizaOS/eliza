---
title: "Plugin Tlon"
sidebarTitle: "Tlon"
description: "Connecteur Tlon pour Eliza — intégration de bot avec la plateforme de messagerie Tlon (Urbit)."
---

Le plugin Tlon connecte les agents Eliza à Tlon (Urbit), permettant la gestion des messages via un ship Urbit connecté.

**Package :** `@elizaos/plugin-tlon`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-tlon
```

<div id="setup">

## Configuration

</div>

<div id="1-get-your-urbit-ship-credentials">

### 1. Obtenez vos identifiants de ship Urbit

</div>

1. Ayez un ship Urbit en fonctionnement (planet, star ou comet)
2. Notez le nom du ship (par exemple, `~zod`)
3. Obtenez le code d'accès depuis l'interface web de votre ship (Paramètres → Clé d'accès)
4. Notez l'URL du ship (par exemple, `http://localhost:8080`)

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "tlon": {
      "ship": "YOUR_SHIP",
      "code": "YOUR_CODE",
      "url": "YOUR_URL"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `ship` | Oui | Nom du ship Urbit (par exemple, `~zod`) |
| `code` | Oui | Code d'accès du ship Urbit |
| `url` | Oui | URL du ship Urbit |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
