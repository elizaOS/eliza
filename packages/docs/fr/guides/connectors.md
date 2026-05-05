---
title: "Connecteurs de plateforme"
sidebarTitle: "Connectors"
description: "Passerelles de plateforme pour 28 plateformes de messagerie — 18 activées automatiquement depuis la configuration (Discord, Telegram, Slack, WhatsApp, Signal, iMessage, Blooio, MS Teams, Google Chat, Twitter, Farcaster, Twitch, Mattermost, Matrix, Feishu, Nostr, Lens, WeChat) plus 10 installables depuis le registre (BlueBubbles, Bluesky, Instagram, LINE, Zalo, Twilio, GitHub, Gmail Watch, Nextcloud Talk, Tlon)."
---

Les connecteurs sont des passerelles de plateforme qui permettent à votre agent de communiquer à travers les plateformes de messagerie et les réseaux sociaux. Chaque connecteur gère l'authentification, le routage des messages, la gestion des sessions et les fonctionnalités spécifiques à la plateforme.

<div id="table-of-contents">
## Table des matières
</div>

1. [Plateformes prises en charge](#supported-platforms)
2. [Configuration générale](#general-configuration)
3. [Discord](#discord)
4. [Telegram](#telegram)
5. [Slack](#slack)
6. [WhatsApp](#whatsapp)
7. [Signal](#signal)
8. [iMessage](#imessage)
9. [BlueBubbles](#bluebubbles)
10. [Blooio](#blooio)
11. [Microsoft Teams](#microsoft-teams)
11. [Google Chat](#google-chat)
12. [Twitter](#twitter)
13. [Farcaster](#farcaster)
14. [Bluesky](#bluesky)
15. [Instagram](#instagram)
16. [Twitch](#twitch)
17. [Mattermost](#mattermost)
18. [WeChat](#wechat)
19. [Matrix](#matrix)
20. [Feishu / Lark](#feishu--lark)
21. [Nostr](#nostr)
22. [LINE](#line)
23. [Zalo](#zalo)
24. [Twilio](#twilio)
25. [GitHub](#github)
26. [Gmail Watch](#gmail-watch)
27. [Nextcloud Talk](#nextcloud-talk)
28. [Tlon](#tlon)
29. [Lens](#lens)
30. [Cycle de vie des connecteurs](#connector-lifecycle)
31. [Support multi-comptes](#multi-account-support)
32. [Gestion des sessions](#session-management)

---

<div id="supported-platforms">
## Plateformes prises en charge
</div>

Les connecteurs marqués **Auto** se chargent automatiquement lorsque leur configuration est présente dans `eliza.json`. Les connecteurs marqués **Registry** doivent d'abord être installés avec `eliza plugins install <package>`.

| Plateforme | Méthode d'authentification | Support MP | Support groupe | Multi-comptes | Disponibilité |
|----------|------------|------------|---------------|---------------|-------------|
| Discord | Token de bot | Oui | Oui (serveurs/salons) | Oui | Auto |
| Telegram | Token de bot | Oui | Oui (groupes/sujets) | Oui | Auto |
| Slack | Tokens bot + app | Oui | Oui (salons/fils) | Oui | Auto |
| WhatsApp | Code QR (Baileys) ou Cloud API | Oui | Oui | Oui | Auto |
| Signal | API HTTP signal-cli | Oui | Oui | Oui | Auto |
| iMessage | CLI natif (macOS) | Oui | Oui | Oui | Auto |
| BlueBubbles | Mot de passe serveur | Oui | Oui | Non | Auto |
| Blooio | Clé API + webhook | Oui | Oui | Non | Auto |
| Microsoft Teams | ID d'app + mot de passe | Oui | Oui (équipes/salons) | Non | Auto |
| Google Chat | Compte de service | Oui | Oui (espaces) | Oui | Auto |
| Twitter | Clés API + tokens | MP | N/A | Non | Registry |
| Farcaster | Clé API Neynar + signataire | Casts | Oui (canaux) | Non | Auto |
| Twitch | ID client + token d'accès | Oui (chat) | Oui (canaux) | Non | Auto |
| Mattermost | Token de bot | Oui | Oui (salons) | Non | Auto |
| WeChat | Clé API proxy + code QR | Oui | Oui | Oui | Registry |
| Matrix | Token d'accès | Oui | Oui (salons) | Non | Auto |
| Feishu / Lark | ID d'app + secret | Oui | Oui (discussions de groupe) | Non | Auto |
| Nostr | Clé privée (nsec/hex) | Oui (NIP-04) | N/A | Non | Auto |
| Lens | Clé API | Oui | N/A | Non | Registry |
| Bluesky | Identifiants de compte | Publications | N/A | Non | Registry |
| Instagram | Nom d'utilisateur + mot de passe | MP | N/A | Non | Registry |
| LINE | Token d'accès + secret du canal | Oui | Oui | Non | Registry |
| Zalo | Token d'accès | Oui | Oui | Non | Registry |
| Twilio | SID de compte + token d'authentification | SMS/Voix | N/A | Non | Registry |
| GitHub | Token API | Issues/PRs | Oui (dépôts) | Non | Registry |
| Gmail Watch | Compte de service / OAuth | N/A | N/A | Non | Registry |
| Nextcloud Talk | Identifiants serveur | Oui | Oui (salons) | Non | Registry |
| Tlon | Identifiants ship | Oui | Oui (chats Urbit) | Non | Registry |

---

<div id="general-configuration">
## Configuration générale
</div>

Les connecteurs sont configurés dans la section `connectors` de `eliza.json`. Champs communs partagés par la plupart des connecteurs :

| Champ | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Activer ou désactiver le connecteur |
| `dmPolicy` | string | Acceptation des MP : `"pairing"` (par défaut), `"open"` ou `"closed"` |
| `allowFrom` | string[] | Liste blanche d'identifiants utilisateur (requise lorsque `dmPolicy: "open"`) |
| `groupPolicy` | string | Politique de messages de groupe : `"allowlist"` (par défaut) ou `"open"` |
| `groupAllowFrom` | string[] | Liste blanche d'identifiants de groupe |
| `historyLimit` | number | Nombre maximum de messages à charger depuis l'historique de conversation |
| `dmHistoryLimit` | number | Nombre maximum de messages pour l'historique des MP |
| `textChunkLimit` | number | Nombre maximum de caractères par segment de message |
| `chunkMode` | string | `"length"` ou `"newline"` -- comment découper les messages longs |
| `blockStreaming` | boolean | Désactiver les réponses en streaming |
| `mediaMaxMb` | number | Taille maximale des pièces jointes en Mo |
| `configWrites` | boolean | Permettre à l'agent de modifier sa propre configuration |
| `capabilities` | string[] | Drapeaux de fonctionnalités pour ce connecteur |
| `markdown` | object | Paramètres de rendu Markdown |
| `heartbeat` | object | Paramètres de visibilité du heartbeat de salon |

---

<div id="discord">
## Discord
</div>

<div id="setup-requirements">
### Prérequis d'installation
</div>

- Token de bot Discord (depuis le portail développeur Discord)
- Le bot doit être invité sur les serveurs cibles avec les permissions appropriées

<div id="key-configuration">
### Configuration clé
</div>

```json
{
  "connectors": {
    "discord": {
      "enabled": true,
      "token": "BOT_TOKEN",
      "groupPolicy": "allowlist",
      "guilds": {
        "SERVER_ID": {
          "requireMention": true,
          "channels": {
            "CHANNEL_ID": {
              "allow": true,
              "requireMention": false
            }
          }
        }
      },
      "dm": {
        "enabled": true,
        "policy": "pairing"
      }
    }
  }
}
```

<div id="features">
### Fonctionnalités
</div>

- Configuration par serveur et par salon
- Politique de MP avec listes blanches
- Notifications de réactions (`off`, `own`, `all`, `allowlist`)
- Approbations d'exécution avec utilisateurs approbateurs désignés
- Intégration PluralKit
- Configuration du mode de réponse
- Configuration des intents (présence, membres du serveur)
- Actions : réactions, autocollants, téléversement d'emojis, sondages, permissions, messages, fils, épingles, recherche, infos membres/rôles/salons, statut vocal, événements, modération, présence

---

<div id="telegram">
## Telegram
</div>

<div id="setup-requirements-1">
### Prérequis d'installation
</div>

- Token de bot depuis @BotFather

<div id="key-configuration-1">
### Configuration clé
</div>

```json
{
  "connectors": {
    "telegram": {
      "enabled": true,
      "botToken": "BOT_TOKEN",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groups": {
        "GROUP_ID": {
          "requireMention": true,
          "topics": {
            "TOPIC_ID": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

<div id="features-1">
### Fonctionnalités
</div>

- Configuration par groupe et par sujet
- Commandes slash personnalisées avec validation
- Boutons en ligne (portée : `off`, `dm`, `group`, `all`, `allowlist`)
- Mode webhook (avec URL de webhook, secret et chemin)
- Mode stream (`off`, `partial`, `block`)
- Notifications de réactions et niveaux de réaction
- Contrôle de l'aperçu des liens
- Configuration réseau (sélection automatique de famille)
- Support proxy

---

<div id="slack">
## Slack
</div>

<div id="setup-requirements-2">
### Prérequis d'installation
</div>

- Token de bot (`xoxb-...`)
- Token d'app (`xapp-...`) pour le mode Socket
- Secret de signature (pour le mode HTTP)

<div id="key-configuration-2">
### Configuration clé
</div>

```json
{
  "connectors": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>",
      "groupPolicy": "allowlist",
      "channels": {
        "CHANNEL_ID": {
          "allow": true,
          "requireMention": true
        }
      }
    }
  }
}
```

<div id="features-2">
### Fonctionnalités
</div>

- Mode Socket ou mode HTTP
- Configuration par salon avec listes blanches
- Historique tenant compte des fils (portée fil ou salon)
- Support de token utilisateur (lecture seule par défaut)
- Intégration de commandes slash (avec option de réponse éphémère)
- Mode de réponse par type de chat (direct, groupe, salon)
- Support des salons de groupe en MP
- Actions : réactions, messages, épingles, recherche, permissions, infos membres, infos salons, liste d'emojis

---

<div id="whatsapp">
## WhatsApp
</div>

<div id="setup-requirements-3">
### Prérequis d'installation
</div>

- Baileys : aucun identifiant externe nécessaire (scan de code QR)
- Cloud API : token d'accès à l'API WhatsApp Business et ID de numéro de téléphone

<div id="key-configuration-3">
### Configuration clé
</div>

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "default": {
          "enabled": true,
          "authDir": "./auth/whatsapp"
        }
      },
      "dmPolicy": "pairing",
      "sendReadReceipts": true,
      "debounceMs": 0
    }
  }
}
```

<div id="features-3">
### Fonctionnalités
</div>

- Répertoire d'authentification par compte pour la persistance de session Baileys
- Mode auto-chat pour les tests
- Préfixe de message pour les messages sortants
- Réactions d'accusé de réception (emoji configurable, comportement MP/groupe)
- Temporisation pour les messages rapides
- Configuration par groupe avec exigences de mention
- Actions : réactions, envoi de message, sondages

Consultez le [Guide d'intégration WhatsApp](/fr/guides/whatsapp) pour des instructions de configuration détaillées.

---

<div id="signal">
## Signal
</div>

<div id="setup-requirements-4">
### Prérequis d'installation
</div>

- signal-cli fonctionnant en mode HTTP/JSON-RPC
- Compte Signal enregistré

<div id="key-configuration-4">
### Configuration clé
</div>

```json
{
  "connectors": {
    "signal": {
      "enabled": true,
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="features-4">
### Fonctionnalités
</div>

- Configuration par URL HTTP ou hôte/port
- Chemin CLI avec démarrage automatique optionnel
- Configuration du délai de démarrage (1-120 secondes)
- Mode de réception (`on-start` ou `manual`)
- Options de gestion des pièces jointes et des stories
- Support des accusés de lecture
- Notifications de réactions et niveaux

---

<div id="imessage">
## iMessage
</div>

<div id="setup-requirements-5">
### Prérequis d'installation
</div>

- macOS avec iMessage configuré
- Outil CLI pour l'accès à iMessage (par ex., `imessage-exporter`)

<div id="key-configuration-5">
### Configuration clé
</div>

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "cliPath": "/usr/local/bin/imessage-exporter",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

> **Note d'activation automatique :** Le connecteur s'active automatiquement lorsque `cliPath` est défini. Sans cela, le plugin ne se chargera pas.

<div id="features-5">
### Fonctionnalités
</div>

- Sélection du service : `imessage`, `sms` ou `auto`
- Configuration du chemin CLI et du chemin de la base de données
- Support d'hôte distant
- Configuration de la région
- Basculement de l'inclusion des pièces jointes
- Configuration des mentions et des outils par groupe

---

<div id="bluebubbles">
## BlueBubbles
</div>

Se connecte à iMessage via un serveur [BlueBubbles](https://bluebubbles.app) local sur macOS. Contrairement au connecteur iMessage direct, BlueBubbles est accessible par réseau — l'agent n'a pas besoin de tourner sur le même Mac qu'iMessage.

### Prérequis d'installation

- Un Mac avec iMessage connecté et le [serveur BlueBubbles](https://bluebubbles.app) installé
- Le mot de passe du serveur et l'URL accessible depuis la machine exécutant Eliza

### Configuration clé

```json
{
  "connectors": {
    "bluebubbles": {
      "password": "VOTRE_MOT_DE_PASSE_BLUEBUBBLES",
      "serverUrl": "http://192.168.1.50:1234"
    }
  }
}
```

**Variables d'environnement :** `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_SERVER_URL`

### Fonctionnalités

- Envoyer et recevoir des iMessages et SMS via un serveur BlueBubbles local
- Réactions tapback (ajout et suppression)
- Répondre à des messages spécifiques dans des fils
- Modifier et annuler des messages envoyés (dépendant de la version macOS)
- Envoyer des pièces jointes avec légendes et effets iMessage
- Gestion des participants de discussions de groupe
- Support des accusés de lecture
- Gestion des messages entrants basée sur les webhooks

Consultez la [référence du connecteur BlueBubbles](/connectors/bluebubbles) pour la référence complète de configuration.

---

<div id="blooio">
## Blooio
</div>

Se connecte à la messagerie iMessage et SMS via le service Blooio avec des webhooks signés.

<div id="setup-requirements-6">
### Prérequis d'installation
</div>

- Clé API Blooio
- URL de webhook pour la réception des messages

<div id="key-configuration-6">
### Configuration clé
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

**Variables d'environnement :** `BLOOIO_API_KEY`, `BLOOIO_WEBHOOK_URL`

<div id="features-6">
### Fonctionnalités
</div>

- Messagerie iMessage et SMS via la passerelle Blooio
- Vérification de webhook signé pour les messages entrants
- Envoi de messages sortants
- Activation automatique lorsque `apiKey` est configuré

---

<div id="microsoft-teams">
## Microsoft Teams
</div>

<div id="setup-requirements-7">
### Prérequis d'installation
</div>

- Enregistrement de bot Azure (ID d'application et mot de passe d'application)
- ID de locataire

<div id="key-configuration-7">
### Configuration clé
</div>

```json
{
  "connectors": {
    "msteams": {
      "enabled": true,
      "botToken": "APP_PASSWORD",
      "appId": "APP_ID",
      "appPassword": "APP_PASSWORD",
      "tenantId": "TENANT_ID",
      "dmPolicy": "pairing"
    }
  }
}
```

> **Note d'activation automatique :** Le connecteur s'active automatiquement lorsque `botToken`, `token` ou `apiKey` est présent dans la configuration. Définissez `botToken` sur le mot de passe de l'application pour déclencher l'activation automatique.

<div id="features-7">
### Fonctionnalités
</div>

- Configuration par équipe et par salon
- Configuration du style de réponse
- Paramètres de port et de chemin du webhook
- Listes blanches d'hôtes média (pour le téléchargement et l'authentification)
- ID de site SharePoint pour les téléversements de fichiers dans les discussions de groupe
- Support média jusqu'à 100 Mo (téléversement OneDrive)

---

<div id="google-chat">
## Google Chat
</div>

<div id="setup-requirements-8">
### Prérequis d'installation
</div>

- Compte de service Google Cloud avec accès à l'API Chat
- Fichier de clé JSON du compte de service ou configuration en ligne

<div id="key-configuration-8">
### Configuration clé
</div>

```json
{
  "connectors": {
    "googlechat": {
      "enabled": true,
      "apiKey": "placeholder",
      "serviceAccountFile": "./service-account.json",
      "audienceType": "project-number",
      "audience": "123456789",
      "webhookPath": "/google-chat"
    }
  }
}
```

> **Note d'activation automatique :** Google Chat utilise l'authentification par compte de service, pas une clé API traditionnelle. Incluez `"apiKey": "placeholder"` pour déclencher l'activation automatique — l'authentification réelle utilise le fichier de compte de service.

<div id="features-8">
### Fonctionnalités
</div>

- Authentification par compte de service (chemin de fichier ou JSON en ligne)
- Configuration du type d'audience (`app-url` ou `project-number`)
- Configuration du chemin et de l'URL du webhook
- Configuration par groupe avec exigences de mention
- Modes d'indicateur de saisie (`none`, `message`, `reaction`)
- Politique de MP avec support des discussions de groupe

---

<div id="twitter">
## Twitter
</div>

<div id="setup-requirements-9">
### Prérequis d'installation
</div>

- Identifiants API Twitter v2 (clé API, clé secrète API, token d'accès, secret du token d'accès)

<div id="key-configuration-9">
### Configuration clé
</div>

```json
{
  "connectors": {
    "twitter": {
      "enabled": true,
      "apiKey": "...",
      "apiSecretKey": "...",
      "accessToken": "...",
      "accessTokenSecret": "...",
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

<div id="features-9">
### Fonctionnalités
</div>

- Publication automatisée avec intervalles et variance configurables
- Option de publication immédiate
- Surveillance des recherches et des mentions
- Sélection de l'algorithme de timeline (`weighted` ou `latest`)
- Réponse automatique aux mentions
- Basculement du traitement des actions
- Mode simulation pour les tests
- Longueur maximale de tweet configurable (par défaut : 4000)

---

<div id="farcaster">
## Farcaster
</div>

<div id="setup-requirements-10">
### Prérequis d'installation
</div>

- Clé API Neynar (depuis [neynar.com](https://neynar.com))
- Compte Farcaster avec un UUID de signataire Neynar
- Identifiant Farcaster (FID) du compte de l'agent

<div id="key-configuration-10">
### Configuration clé
</div>

```json
{
  "connectors": {
    "farcaster": {
      "enabled": true,
      "apiKey": "YOUR_NEYNAR_API_KEY",
      "signerUuid": "YOUR_SIGNER_UUID",
      "fid": 12345,
      "channels": ["ai", "agents"],
      "castIntervalMin": 120,
      "castIntervalMax": 240
    }
  }
}
```

<div id="features-10">
### Fonctionnalités
</div>

- Publication autonome (casting) à intervalles configurables
- Réponse aux @mentions et aux réponses de casts
- Surveillance et participation aux canaux
- Réactions (likes et recasts)
- Casts directs (messages privés)
- Identité on-chain liée à l'adresse Ethereum
- Découpage des fils de casts pour les messages dépassant 320 caractères

---

<div id="bluesky">
## Bluesky
</div>

<div id="setup-requirements-11">
### Prérequis d'installation
</div>

- Identifiants de compte Bluesky (handle et mot de passe d'application)

<div id="key-configuration-11">
### Configuration clé
</div>

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

**Variables d'environnement :** `BLUESKY_ENABLED`, `BLUESKY_DRY_RUN`, `BLUESKY_USERNAME`, `BLUESKY_PASSWORD`, `BLUESKY_HANDLE`

<div id="features-11">
### Fonctionnalités
</div>

- Création de publications à intervalles configurables
- Surveillance des mentions et des réponses
- Mode simulation pour les tests
- Réseau social décentralisé basé sur le protocole AT

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-bluesky`.

---

<div id="instagram">
## Instagram
</div>

<div id="setup-requirements-12">
### Prérequis d'installation
</div>

- Identifiants de compte Instagram (nom d'utilisateur et mot de passe)

<div id="key-configuration-12">
### Configuration clé
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

**Variables d'environnement :** `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, `INSTAGRAM_DRY_RUN`, `INSTAGRAM_POLL_INTERVAL`, `INSTAGRAM_POST_INTERVAL_MIN`, `INSTAGRAM_POST_INTERVAL_MAX`

<div id="features-12">
### Fonctionnalités
</div>

- Publication de médias avec génération de légendes
- Surveillance et réponse aux commentaires
- Gestion des MP
- Mode simulation pour les tests
- Intervalles de publication et de sondage configurables

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-instagram`.

---

<div id="twitch">
## Twitch
</div>

<div id="setup-requirements-13">
### Prérequis d'installation
</div>

- ID client et token d'accès de l'application Twitch
- Canal Twitch auquel se connecter

<div id="key-configuration-13">
### Configuration clé
</div>

```json
{
  "connectors": {
    "twitch": {
      "enabled": true,
      "clientId": "YOUR_CLIENT_ID",
      "accessToken": "YOUR_ACCESS_TOKEN"
    }
  }
}
```

<div id="features-13">
### Fonctionnalités
</div>

- Surveillance et réponse au chat en direct
- Gestion des événements de canal
- Gestion des interactions avec l'audience
- Activation automatique lorsque `clientId` ou `accessToken` est configuré

---

<div id="mattermost">
## Mattermost
</div>

<div id="setup-requirements-14">
### Prérequis d'installation
</div>

- Token de bot Mattermost (depuis Console système > Intégrations > Comptes de bot)
- URL du serveur Mattermost

<div id="key-configuration-14">
### Configuration clé
</div>

```json
{
  "connectors": {
    "mattermost": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com",
      "chatmode": "all",
      "requireMention": false
    }
  }
}
```

**Variables d'environnement :** `MATTERMOST_BOT_TOKEN`, `MATTERMOST_SERVER_URL`

<div id="features-14">
### Fonctionnalités
</div>

- Messagerie dans les salons et en MP
- Restriction du mode de chat (`dm-only`, `channel-only` ou `all`)
- Filtrage par mention (exiger optionnellement les @mentions)
- Déclencheurs de préfixe de commande personnalisé
- Support de serveur auto-hébergé

---

<div id="wechat">
## WeChat
</div>

Se connecte à WeChat via un service proxy tiers utilisant la connexion par compte personnel.

<div id="setup-requirements-15">
### Prérequis d'installation
</div>

1. Obtenir une clé API du service proxy WeChat
2. Configurer l'URL du proxy et le port du webhook
3. Scanner le code QR affiché dans le terminal au premier démarrage

<div id="privacy-notice">
### Avis de confidentialité
</div>

Le connecteur WeChat dépend d'un service proxy fourni par l'utilisateur. Ce proxy reçoit
votre clé API de connecteur ainsi que les charges utiles de messages et les métadonnées nécessaires
pour relayer le trafic WeChat entrant et sortant. Ne pointez `proxyUrl` que vers une infrastructure
que vous exploitez vous-même ou en laquelle vous avez explicitement confiance pour ce flux de messages.

<div id="key-configuration-15">
### Configuration clé
</div>

```json
{
  "connectors": {
    "wechat": {
      "apiKey": "<key>",
      "proxyUrl": "https://...",
      "webhookPort": 18790,
      "deviceType": "ipad"
    }
  }
}
```

| Champ | Description |
|-------|------------|
| `apiKey` | **Requis** -- Clé API du service proxy |
| `proxyUrl` | **Requis** -- URL du service proxy |
| `webhookPort` | Port du listener webhook (par défaut : 18790) |
| `deviceType` | Type d'émulation d'appareil : `ipad` ou `mac` (par défaut : `ipad`) |

**Variables d'environnement :** `WECHAT_API_KEY`

**Multi-comptes :** Supporté via la map `accounts` (même schéma que WhatsApp).

<div id="features-15">
### Fonctionnalités
</div>

- Messagerie texte en MP (activée par défaut)
- Support des discussions de groupe (activer avec `features.groups: true`)
- Envoi/réception d'images (activer avec `features.images: true`)
- Connexion par code QR avec persistance automatique de session
- Support multi-comptes via la map accounts

---

<div id="matrix">
## Matrix
</div>

<div id="setup-requirements-16">
### Prérequis d'installation
</div>

- Compte Matrix sur n'importe quel homeserver (par ex., matrix.org ou auto-hébergé)
- Token d'accès pour le compte bot

<div id="key-configuration-16">
### Configuration clé
</div>

```json
{
  "env": {
    "MATRIX_ACCESS_TOKEN": "syt_your_access_token"
  },
  "connectors": {
    "matrix": {
      "enabled": true,
      "token": "syt_your_access_token"
    }
  }
}
```

> **Note d'activation automatique :** Le connecteur s'active automatiquement lorsque `token`, `botToken` ou `apiKey` est présent dans la configuration du connecteur. Définir `"enabled": true` seul n'est pas suffisant — incluez le champ `token`.

**Variables d'environnement :** `MATRIX_ACCESS_TOKEN`, `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_DEVICE_ID`, `MATRIX_ROOMS`, `MATRIX_AUTO_JOIN`, `MATRIX_ENCRYPTION`, `MATRIX_REQUIRE_MENTION`

<div id="features-16">
### Fonctionnalités
</div>

- Messagerie dans les salons et en MP sur n'importe quel homeserver conforme aux spécifications
- Rejoindre automatiquement les invitations de salon
- Support du chiffrement de bout en bout (Olm)
- Filtrage par mention dans les salons
- Support de la fédération entre homeservers

---

<div id="feishu--lark">
## Feishu / Lark
</div>

<div id="setup-requirements-17">
### Prérequis d'installation
</div>

- Application personnalisée Feishu/Lark avec ID d'application et secret d'application
- Capacité bot activée sur l'application

<div id="key-configuration-17">
### Configuration clé
</div>

```json
{
  "env": {
    "FEISHU_APP_ID": "cli_your_app_id",
    "FEISHU_APP_SECRET": "your_app_secret"
  },
  "connectors": {
    "feishu": {
      "enabled": true,
      "apiKey": "your_app_secret"
    }
  }
}
```

> **Note d'activation automatique :** Le connecteur s'active automatiquement lorsque `apiKey`, `token` ou `botToken` est présent dans la configuration du connecteur. Définissez `apiKey` sur le secret de l'application pour déclencher l'activation automatique.

**Variables d'environnement :** `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`, `FEISHU_ALLOWED_CHATS`

<div id="features-17">
### Fonctionnalités
</div>

- Messagerie directe du bot et discussions de groupe
- Liste blanche de chats pour le contrôle d'accès
- Support des domaines Chine (`feishu.cn`) et global (`larksuite.com`)
- Abonnement aux événements pour les messages en temps réel

---

<div id="nostr">
## Nostr
</div>

<div id="setup-requirements-18">
### Prérequis d'installation
</div>

- Clé privée Nostr (format nsec ou hex)

<div id="key-configuration-18">
### Configuration clé
</div>

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key"
  },
  "connectors": {
    "nostr": {
      "enabled": true,
      "token": "placeholder"
    }
  }
}
```

> **Note d'activation automatique :** Nostr utilise l'authentification par clé, pas un token traditionnel. Incluez `"token": "placeholder"` dans la configuration du connecteur pour déclencher l'activation automatique — l'authentification réelle utilise la variable d'environnement `NOSTR_PRIVATE_KEY`.

**Variables d'environnement :** `NOSTR_PRIVATE_KEY`, `NOSTR_RELAYS`, `NOSTR_DM_POLICY`, `NOSTR_ALLOW_FROM`, `NOSTR_ENABLED`

<div id="features-18">
### Fonctionnalités
</div>

- Connectivité multi-relais
- Publication de notes (événements kind 1)
- Messages directs chiffrés NIP-04
- Politiques d'accès MP (autoriser, refuser, liste blanche)
- Entièrement décentralisé via le réseau de relais

---

<div id="line">
## LINE
</div>

<div id="setup-requirements-19">
### Prérequis d'installation
</div>

- Token d'accès du canal LINE
- Secret du canal LINE

<div id="key-configuration-19">
### Configuration clé
</div>

```json
{
  "connectors": {
    "line": {
      "enabled": true
    }
  }
}
```

**Variables d'environnement :** `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_CUSTOM_GREETING`

<div id="features-19">
### Fonctionnalités
</div>

- Messagerie bot et conversations clients
- Types de messages enrichis (texte, autocollant, image, vidéo)
- Support des discussions de groupe
- Gestion d'événements basée sur les webhooks

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-line`.

---

<div id="zalo">
## Zalo
</div>

<div id="setup-requirements-20">
### Prérequis d'installation
</div>

- Token d'accès du compte officiel Zalo (OA)

<div id="key-configuration-20">
### Configuration clé
</div>

```json
{
  "connectors": {
    "zalo": {
      "enabled": true
    }
  }
}
```

**Variables d'environnement :** `ZALO_ACCESS_TOKEN`, `ZALO_REFRESH_TOKEN`, `ZALO_APP_ID`, `ZALO_APP_SECRET`

<div id="features-20">
### Fonctionnalités
</div>

- Messagerie de compte officiel et workflows de support
- Gestion de messages basée sur les webhooks
- Gestion des interactions clients

Une variante pour compte personnel est également disponible sous `@elizaos/plugin-zalouser` pour la messagerie individuelle en dehors du système de compte officiel.

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-zalo`.

---

<div id="twilio">
## Twilio
</div>

<div id="setup-requirements-21">
### Prérequis d'installation
</div>

- SID de compte Twilio et token d'authentification
- Un numéro de téléphone Twilio

<div id="key-configuration-21">
### Configuration clé
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

**Variables d'environnement :** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

<div id="features-21">
### Fonctionnalités
</div>

- Messagerie SMS (envoi et réception)
- Capacités d'appels vocaux
- Gestion des messages entrants basée sur les webhooks

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-twilio`.

---

<div id="github">
## GitHub
</div>

<div id="setup-requirements-22">
### Prérequis d'installation
</div>

- Token API GitHub (token d'accès personnel ou token à portée fine)

<div id="key-configuration-22">
### Configuration clé
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

**Variables d'environnement :** `GITHUB_API_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`

<div id="features-22">
### Fonctionnalités
</div>

- Gestion de dépôts
- Suivi et création d'issues
- Workflows de pull requests (création, revue, fusion)
- Recherche de code et accès aux fichiers

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-github`.

---

<div id="gmail-watch">
## Gmail Watch
</div>

<div id="setup-requirements-23">
### Prérequis d'installation
</div>

- Compte de service Google Cloud ou identifiants OAuth avec accès à l'API Gmail

<div id="key-configuration-23">
### Configuration clé
</div>

Gmail Watch est activé via le drapeau `features.gmailWatch` ou les variables d'environnement plutôt que la section `connectors`.

<div id="features-23">
### Fonctionnalités
</div>

- Surveillance des messages Gmail via Pub/Sub
- Renouvellement automatique des abonnements de surveillance
- Gestion des événements d'e-mails entrants

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-gmail-watch`.

---

<div id="nextcloud-talk">
## Nextcloud Talk
</div>

<div id="setup-requirements-24">
### Prérequis d'installation
</div>

- URL du serveur Nextcloud et identifiants

<div id="key-configuration-24">
### Configuration clé
</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="features-24">
### Fonctionnalités
</div>

- Messagerie basée sur les salons
- Support des conversations en MP et en groupe
- Intégration de plateforme de collaboration auto-hébergée

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-nextcloud-talk`.

---

<div id="tlon">
## Tlon
</div>

<div id="setup-requirements-25">
### Prérequis d'installation
</div>

- Identifiants de ship Tlon (nom de ship Urbit et code d'accès)

<div id="key-configuration-25">
### Configuration clé
</div>

```json
{
  "connectors": {
    "tlon": {
      "enabled": true
    }
  }
}
```

**Variables d'environnement :** `TLON_SHIP`, `TLON_CODE`, `TLON_URL`

<div id="features-25">
### Fonctionnalités
</div>

- Chat et interactions sociales basés sur Urbit
- Messagerie ship-to-ship
- Participation aux discussions de groupe

**Note :** Ce connecteur est disponible depuis le registre de plugins. Installez-le avec `eliza plugins install @elizaos/plugin-tlon`.

---

<div id="lens">
## Lens
</div>

**Plugin :** `@elizaos/plugin-lens`

```json5
{
  connectors: {
    lens: {
      apiKey: "<LENS_API_KEY>",
    }
  }
}
```

| Variable d'environnement | Chemin de configuration |
|-------------|-------------|
| `LENS_API_KEY` | `connectors.lens.apiKey` |

**Déclencheurs d'activation automatique :** `apiKey`, `token` ou `botToken`.

**Fonctionnalités :**
- Interactions sociales sur le protocole Lens
- Publication et engagement

---

<div id="connector-lifecycle">
## Cycle de vie des connecteurs
</div>

Le cycle de vie typique d'un connecteur suit ce schéma :

1. **Installer le plugin** -- Les plugins de connecteur sont installés en tant que packages `@elizaos/plugin-{platform}`
2. **Configurer** -- Ajouter la configuration de la plateforme dans la section `connectors` de `eliza.json`
3. **Activer** -- Définir `enabled: true` dans la configuration du connecteur
4. **Authentifier** -- Fournir les identifiants (tokens, clés) ou compléter le flux d'authentification (scan de code QR)
5. **Exécuter** -- Le runtime démarre le connecteur, établit les connexions et commence la gestion des messages
6. **Surveiller** -- Les sondes de statut vérifient la connectivité ; la reconnexion se fait automatiquement en cas d'échec

---

<div id="multi-account-support">
## Support multi-comptes
</div>

La plupart des connecteurs supportent plusieurs comptes via la clé `accounts`. Chaque compte a sa propre configuration, authentification et état de session :

```json
{
  "connectors": {
    "telegram": {
      "dmPolicy": "pairing",
      "accounts": {
        "main-bot": {
          "enabled": true,
          "botToken": "TOKEN_1"
        },
        "support-bot": {
          "enabled": true,
          "botToken": "TOKEN_2",
          "dmPolicy": "open",
          "allowFrom": ["*"]
        }
      }
    }
  }
}
```

Les paramètres au niveau du compte remplacent les paramètres de base du connecteur. Chaque compte fonctionne indépendamment avec sa propre connexion, ses identifiants et son état de session.

---

<div id="session-management">
## Gestion des sessions
</div>

Tous les connecteurs gèrent des sessions qui suivent l'état de la conversation à travers les plateformes :

- **Sessions MP** -- une session par utilisateur, régie par `dmPolicy`
- **Sessions de groupe** -- une session par groupe/salon, régie par `groupPolicy`
- **Historique** -- profondeur d'historique de messages configurable par type de session (`historyLimit`, `dmHistoryLimit`)
- **Configurations MP** -- surcharges de MP par utilisateur via l'enregistrement `dms`

Les options de `dmPolicy` sont :

| Politique | Comportement |
|--------|----------|
| `pairing` | Par défaut. L'agent répond après un flux d'appairage/d'intégration. |
| `open` | L'agent répond à tous les MP. Nécessite `allowFrom: ["*"]`. |
| `closed` | L'agent ne répond pas aux MP. |

---

<div id="connector-operations-runbook">
## Guide opérationnel des connecteurs
</div>

<div id="setup-checklist">
### Liste de vérification de configuration
</div>

1. Configurer les identifiants du connecteur sous `connectors.<name>`.
2. Activer le chargement du plugin connecteur via la configuration du connecteur ou la liste d'autorisation des plugins.
3. Valider les valeurs de politique MP/groupe et les listes d'autorisation avant d'activer les politiques `open`.
4. Pour chaque connecteur, confirmer que le bot/app de la plateforme est créé et que les tokens sont valides (voir les notes spécifiques à la plateforme ci-dessous).
5. Tester la connectivité en mode `pairing` avant de passer au mode `open`.

<div id="failure-modes">
### Modes de défaillance
</div>

**Défaillances générales des connecteurs :**

- Le plugin du connecteur ne se charge pas :
  Vérifiez le mappage des ID de connecteur dans `eliza/packages/agent/src/config/plugin-auto-enable.ts` (dans le sous-module upstream elizaOS), la disponibilité du plugin et les surcharges de `plugins.entries`. La couche d'activation automatique mappe les clés de configuration du connecteur aux noms de packages de plugins — une incohérence signifie que le plugin est silencieusement ignoré.
- L'authentification réussit mais aucun message n'arrive :
  Vérifiez les paramètres de webhook/socket de la plateforme et les portes de politique (`dmPolicy`, `groupPolicy`). Pour les connecteurs basés sur les webhooks, confirmez que l'URL de rappel est publiquement accessible.
- Secrets de connecteur mal routés :
  Confirmez que les variables d'environnement attendues sont remplies depuis la configuration et ne sont pas écrasées par un environnement obsolète. Le schéma de configuration fusionne les variables d'environnement avec la configuration de fichier — l'environnement a la priorité.

**Discord :**

- Token de bot rejeté (`401 Unauthorized`) :
  Régénérez le token de bot dans le portail développeur Discord. Les tokens sont invalidés si le mot de passe du bot est réinitialisé ou si le token est divulgué et automatiquement révoqué.
- Le bot est en ligne mais ne répond pas dans les salons :
  Vérifiez que le bot a l'intent `MESSAGE_CONTENT` activé dans le portail développeur et que la `groupPolicy` n'est pas `closed`. Confirmez que le bot a la permission `Send Messages` dans le salon cible.
- Limitation de débit (`429 Too Many Requests`) :
  Les limites de débit Discord sont par route. Le connecteur devrait reculer automatiquement. Si c'est persistant, réduisez la fréquence des messages ou vérifiez les boucles de messages (le bot se répondant à lui-même).

**Telegram :**

- Le webhook ne reçoit pas les mises à jour :
  Telegram nécessite HTTPS avec un certificat valide. Utilisez `getWebhookInfo` pour vérifier le statut. Si vous utilisez le long polling, confirmez qu'aucun autre processus ne sonde le même token de bot (Telegram n'autorise qu'un seul consommateur).
- Token de bot expiré ou révoqué :
  Recréez le bot via BotFather et mettez à jour `TELEGRAM_BOT_TOKEN`. Les tokens Telegram n'expirent pas automatiquement mais peuvent être révoqués.
- Messages retardés ou manquants :
  Telegram met les mises à jour en tampon pendant 24 heures si le webhook est inaccessible. Après restauration de la connectivité, un flot de messages en retard peut arriver.

**Slack :**

- `invalid_auth` ou `token_revoked` :
  Réinstallez l'application Slack dans l'espace de travail. Les tokens de bot sont révoqués lorsque l'application est désinstallée ou que les permissions de l'espace de travail changent.
- Les événements n'arrivent pas :
  Confirmez que l'abonnement à l'API Events inclut les types d'événements requis (`message.im`, `message.channels`). Vérifiez que l'URL de requête de l'application Slack est vérifiée et reçoit les réponses de défi.

**WhatsApp :**

- L'appairage QR échoue ou la session se déconnecte :
  Les sessions WhatsApp Web expirent après une inactivité prolongée. Réappairez en scannant un nouveau code QR via `POST /api/whatsapp/pair`. Le service `whatsapp-pairing` gère l'état de session.
- Les messages ne sont pas délivrés :
  WhatsApp applique des politiques anti-spam strictes. Si le numéro est signalé, les messages sont silencieusement supprimés. Confirmez que le compte professionnel est en règle.
- Problèmes de répertoire d'authentification multi-comptes :
  Chaque compte WhatsApp nécessite son propre `authDir` (état d'authentification multi-fichiers Baileys). Si plusieurs comptes partagent un répertoire, les sessions se corrompent mutuellement.

**Signal :**

- signal-cli introuvable :
  Le connecteur nécessite `signal-cli` dans le PATH ou un `cliPath` configuré. Pour le mode HTTP, définissez `httpUrl` ou `httpHost`/`httpPort` pour pointer vers une API REST signal-cli en cours d'exécution.
- L'enregistrement du compte échoue :
  Signal nécessite un numéro de téléphone vérifié. Utilisez `signal-cli register` ou fournissez un numéro de compte pré-enregistré via `connectors.signal.account`.
- Configuration multi-comptes :
  Signal supporte plusieurs comptes via la map `accounts`. Chaque compte doit avoir `account`, `httpUrl` ou `cliPath` défini et ne doit pas être `enabled: false`.

**Twitter :**

- Clé API rejetée :
  Confirmez que `connectors.twitter.apiKey` est une clé API Twitter/X valide. Les clés du niveau gratuit ont des limites de débit strictes.
- Échecs de récupération de tweets :
  L'API FxTwitter (`api.fxtwitter.com`) est utilisée pour la vérification des tweets. Si la limite de débit est atteinte, les requêtes de vérification échouent silencieusement.

**iMessage (direct) :**

- Chemin CLI introuvable :
  Nécessite `cliPath` pointant vers un outil CLI iMessage valide. macOS uniquement — les permissions d'accessibilité sont requises.

**Farcaster :**

- Clé API invalide :
  Confirmez que `connectors.farcaster.apiKey` est défini. L'accès au hub Farcaster nécessite une clé API valide.

**Lens :**

- Clé API invalide :
  Confirmez que `connectors.lens.apiKey` est défini et que l'API Lens est accessible.

**MS Teams :**

- Token de bot rejeté :
  Les bots Teams nécessitent un enregistrement Azure AD. Confirmez que le token de bot est valide et que l'application a les permissions requises dans le portail Azure.

**Mattermost :**

- L'authentification par token échoue :
  Confirmez que `connectors.mattermost.botToken` (env : `MATTERMOST_BOT_TOKEN`) est un token d'accès personnel ou un token de bot valide. Vérifiez que l'URL du serveur Mattermost est configurée.

**Google Chat / Feishu :**

- L'authentification par token échoue :
  Les deux nécessitent des comptes de service ou des tokens de bot. Confirmez que le token est valide et dispose des portées API de chat requises.

**Matrix :**

- La connexion au homeserver échoue :
  Confirmez que l'URL du homeserver Matrix est accessible et que le token d'accès sous `connectors.matrix.token` est valide.

**Nostr :**

- La connexion au relais échoue :
  Les connecteurs Nostr communiquent via des relais. Confirmez que les URL des relais sont configurées et accessibles. L'authentification par clé API varie selon le relais.

**Twitch :**

- L'authentification échoue :
  Confirmez que `connectors.twitch.accessToken` ou `connectors.twitch.clientId` est défini. Alternativement, définissez `enabled: true` pour forcer l'activation. Assurez-vous que le token d'accès dispose des portées de chat requises.

**Blooio :**

- L'authentification échoue :
  Blooio utilise `apiKey`. Confirmez que les identifiants sont définis dans la configuration du connecteur.

**Bluesky :**

- L'authentification échoue :
  Confirmez que les variables d'environnement `BLUESKY_USERNAME` et `BLUESKY_PASSWORD` sont définies. Bluesky utilise des mots de passe d'application, pas le mot de passe de votre compte principal.

**Instagram :**

- La connexion échoue ou le compte est verrouillé :
  Instagram peut exiger une vérification pour les connexions automatisées. Utilisez un mot de passe spécifique à l'application si disponible. Évitez les tentatives de connexion fréquentes qui peuvent déclencher des verrouillages de compte.

**LINE :**

- Le webhook ne reçoit pas les messages :
  Confirmez que `LINE_CHANNEL_ACCESS_TOKEN` et `LINE_CHANNEL_SECRET` sont définis. L'URL du webhook doit être publiquement accessible avec HTTPS.

**Twilio :**

- Les SMS ne s'envoient pas :
  Confirmez que `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` et `TWILIO_PHONE_NUMBER` sont définis. Vérifiez que le numéro de téléphone est compatible SMS et que le compte a un solde suffisant.

**GitHub :**

- Token API rejeté :
  Confirmez que `GITHUB_API_TOKEN` est un token d'accès personnel ou un token à portée fine valide avec les permissions de dépôt requises.

<div id="recovery-procedures">
### Procédures de récupération
</div>

1. **Session de connecteur obsolète :** Redémarrez l'agent. Les connecteurs réinitialisent leurs connexions de plateforme au démarrage. Pour les connecteurs basés sur WebSocket (Discord, Slack), cela force une nouvelle poignée de main.
2. **Rotation de token :** Mettez à jour le token dans `eliza.json` sous `connectors.<name>` et redémarrez. Ne modifiez pas les variables d'environnement dans un processus en cours d'exécution — la configuration est lue au démarrage.
3. **Récupération de limite de débit :** L'agent recule automatiquement sur les réponses 429. Si le connecteur est complètement bloqué, attendez que la fenêtre de limite de débit expire (typiquement 1 à 60 secondes pour Discord, variable selon la plateforme) et redémarrez.

<div id="verification-commands">
### Commandes de vérification
</div>

Ces chemins de test font référence à des fichiers dans le sous-module `eliza`. Exécutez `bun run setup:upstreams` d'abord pour l'initialiser.

```bash
# Suite de tests complète (depuis la racine du dépôt)
bun run test

# Tests de bout en bout
bun run test:e2e

bun run typecheck
```
