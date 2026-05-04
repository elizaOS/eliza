---
title: Connecteur Twilio
sidebarTitle: Twilio
description: Connectez votre agent à Twilio pour le SMS et la voix en utilisant le package @elizaos/plugin-twilio.
---

Connectez votre agent à Twilio pour la messagerie SMS et les capacités d'appel vocal.

<div id="overview">

## Vue d'ensemble

</div>

Le connecteur Twilio est un plugin elizaOS qui relie votre agent aux API de communication de Twilio. Il prend en charge les SMS entrants et sortants, ainsi que les capacités d'appel vocal. Ce connecteur est disponible dans le registre de plugins.

<div id="package-info">

## Informations du package

</div>

| Champ | Valeur |
|-------|--------|
| Package | `@elizaos/plugin-twilio` |
| Clé de configuration | `connectors.twilio` |
| Installation | `eliza plugins install @elizaos/plugin-twilio` |

<div id="setup-requirements">

## Prérequis de configuration

</div>

- Account SID et Auth Token Twilio
- Un numéro de téléphone Twilio

<div id="configuration">

## Configuration

</div>

```json
{
  "connectors": {
    "twilio": {
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
| `TWILIO_ACCOUNT_SID` | Account SID Twilio |
| `TWILIO_AUTH_TOKEN` | Auth Token Twilio |
| `TWILIO_PHONE_NUMBER` | Numéro de téléphone Twilio pour l'envoi/réception |

<div id="features">

## Fonctionnalités

</div>

- Messagerie SMS (envoi et réception)
- Capacités d'appel vocal
- Gestion des messages entrants par webhooks

<div id="related">

## Associé

</div>

- [Vue d'ensemble des connecteurs](/fr/guides/connectors#twilio)
