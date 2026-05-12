---
title: "Plugin iMessage"
sidebarTitle: "iMessage"
description: "Connecteur iMessage pour Eliza — messagerie native macOS avec prise en charge d'iMessage et SMS, accès à la base de données et connectivité avec hôte distant."
---

Le plugin iMessage connecte les agents Eliza à iMessage sur macOS, prenant en charge les conversations iMessage et SMS avec sélection de service configurable et gestion des pièces jointes.

**Package :** `@elizaos/plugin-imessage`

<div id="installation">
## Installation
</div>

```bash
eliza plugins install @elizaos/plugin-imessage
```

<div id="setup">
## Mise en place
</div>

<div id="1-prerequisites">
### 1. Prérequis
</div>

- macOS avec iMessage configuré et connecté
- Accès complet au disque accordé au terminal ou à l'application exécutant Eliza (pour l'accès à la base de données de chat)

<div id="2-configure-eliza">
### 2. Configurer Eliza
</div>

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="configuration">
## Configuration
</div>

| Champ | Requis | Description |
|-------|--------|-------------|
| `service` | Non | Type de service : `imessage`, `sms` ou `auto` (défaut : `auto`) |
| `cliPath` | Non | Chemin vers l'outil CLI iMessage |
| `dbPath` | Non | Chemin vers la base de données iMessage |
| `remoteHost` | Non | Hôte distant pour l'accès via SSH |
| `region` | Non | Configuration de région |
| `includeAttachments` | Non | Inclure les pièces jointes dans les messages (défaut : `true`) |
| `dmPolicy` | Non | Politique de gestion des DMs |

<div id="features">
## Fonctionnalités
</div>

- **Sélection du service** — Choisissez entre iMessage, SMS ou détection automatique
- **Accès à la base de données** — Accès direct à la base de données iMessage de macOS pour l'historique des messages
- **Hôte distant** — Connectez-vous à iMessage sur un Mac distant via SSH
- **Pièces jointes** — Envoyez et recevez des pièces jointes multimédias
- **Configuration par groupe** — Configurez les exigences de mention et l'accès aux outils par groupe
- **Multi-comptes** — Prend en charge plusieurs comptes via le champ `accounts`

<div id="auto-enable">
## Activation automatique
</div>

Le plugin s'active automatiquement lorsque le bloc `connectors.imessage` est présent :

```json
{
  "connectors": {
    "imessage": {
      "enabled": true
    }
  }
}
```

<div id="troubleshooting">
## Dépannage
</div>

<div id="full-disk-access">
### Accès complet au disque
</div>

Si la récupération des messages échoue, assurez-vous que l'Accès complet au disque est accordé :

1. Ouvrez **Réglages Système → Confidentialité et sécurité → Accès complet au disque**
2. Ajoutez l'application de terminal ou le processus Eliza

<div id="database-path">
### Chemin de la base de données
</div>

La base de données iMessage par défaut se trouve à `~/Library/Messages/chat.db`. Si vous utilisez un emplacement non standard, définissez `dbPath` explicitement.

<div id="related">
## Liens connexes
</div>

- [Plugin Signal](/fr/plugin-registry/platform/signal) — Intégration de messagerie Signal
- [Guide des connecteurs](/fr/guides/connectors) — Documentation générale des connecteurs
