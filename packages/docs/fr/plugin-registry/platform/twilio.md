---
title: "Plugin Twilio"
sidebarTitle: "Twilio"
description: "Connecteur Twilio pour Eliza — intégration SMS et voix via l'API Twilio."
---

Le plugin Twilio connecte les agents Eliza à Twilio, permettant la messagerie SMS et les interactions vocales via des numéros de téléphone Twilio.

**Package :** `@elizaos/plugin-twilio`

<div id="installation">

## Installation

</div>

```bash
eliza plugins install @elizaos/plugin-twilio
```

<div id="setup">

## Configuration

</div>

<div id="1-get-your-twilio-credentials">

### 1. Obtenez vos identifiants Twilio

</div>

1. Inscrivez-vous sur [twilio.com](https://www.twilio.com/)
2. Depuis le tableau de bord de la Console Twilio, copiez votre **Account SID** et **Auth Token**
3. Achetez ou configurez un numéro de téléphone Twilio

<div id="2-configure-eliza">

### 2. Configurez Eliza

</div>

```json
{
  "connectors": {
    "twilio": {
      "accountSid": "YOUR_ACCOUNT_SID",
      "authToken": "YOUR_AUTH_TOKEN",
      "phoneNumber": "YOUR_PHONE_NUMBER"
    }
  }
}
```

Ou via des variables d'environnement :

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="configuration">

## Configuration

</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `accountSid` | Oui | Account SID Twilio |
| `authToken` | Oui | Auth Token Twilio |
| `phoneNumber` | Oui | Numéro de téléphone Twilio (format E.164) |
| `enabled` | Non | Définir `false` pour désactiver (par défaut : `true`) |

<div id="environment-variables">

## Variables d'environnement

</div>

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="related">

## Associé

</div>

- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
