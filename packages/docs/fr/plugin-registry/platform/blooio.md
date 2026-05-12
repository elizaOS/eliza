---
title: "Plugin Blooio"
sidebarTitle: "Blooio"
description: "Connecteur Blooio pour Eliza — messagerie iMessage et SMS via le service pont Blooio avec webhooks signés."
---

Le plugin Blooio connecte les agents Eliza à la messagerie iMessage et SMS via le service Blooio. Les messages entrants sont livrés via des webhooks signés pour la sécurité.

**Package :** `@elizaos/plugin-blooio`

<div id="installation">
## Installation
</div>

```bash
eliza plugins install @elizaos/plugin-blooio
```

<div id="setup">
## Mise en place
</div>

<div id="1-get-blooio-credentials">
### 1. Obtenir les identifiants Blooio
</div>

Obtenez une clé API depuis votre compte Blooio.

<div id="2-configure-eliza">
### 2. Configurer Eliza
</div>

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

Ou utilisez des variables d'environnement :

```bash
export BLOOIO_API_KEY=your-blooio-api-key
export BLOOIO_WEBHOOK_URL=https://your-domain.com/blooio/webhook
```

<div id="auto-enable">
## Activation automatique
</div>

Le plugin s'active automatiquement lorsque `apiKey`, `token` ou `botToken` est présent dans la configuration du connecteur.

<div id="configuration">
## Configuration
</div>

| Variable | Requis | Description |
|----------|--------|-------------|
| `apiKey` | Oui | Clé API de la plateforme Blooio |
| `webhookUrl` | Non | URL publique pour recevoir les messages entrants |

<div id="features">
## Fonctionnalités
</div>

- Messagerie iMessage et SMS via le pont Blooio
- Vérification des webhooks signés pour la sécurité des messages entrants
- Envoi de messages sortants
- Gestion des sessions et routage des messages

<div id="related">
## Liens connexes
</div>

- [Plugin iMessage](/fr/plugin-registry/platform/imessage) — iMessage natif macOS (sans pont nécessaire)
- [Guide des connecteurs](/fr/guides/connectors#blooio) — Référence complète de configuration
