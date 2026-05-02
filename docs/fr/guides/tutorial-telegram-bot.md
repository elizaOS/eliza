---
title: "Tutoriel : Bot Telegram"
sidebarTitle: "Configuration du bot Telegram"
description: "Apprenez à créer et configurer un bot Telegram avec Eliza en quelques minutes"
---

<div id="tutorial-telegram-bot">
# Tutoriel : Bot Telegram
</div>

Démarrez avec l'intégration du bot Telegram de Eliza. Ce tutoriel vous guide à travers la création de votre premier bot, sa configuration et ses tests de bout en bout.

<Info>
  Ce tutoriel suppose que vous avez installé Eliza. Si ce n'est pas encore fait, consultez le [Guide d'installation](/fr/installation).
</Info>

<div id="prerequisites">
## Prérequis
</div>

Avant de commencer, assurez-vous d'avoir :

- Un compte Telegram
- Eliza installé et en cours d'exécution (`bun run dev`)
- Accès au tableau de bord Eliza (par défaut : http://localhost:2138)

<div id="quick-setup-via-dashboard">
## Configuration rapide via le tableau de bord
</div>

Le moyen le plus rapide de configurer le connecteur Telegram est via le tableau de bord Eliza :

1. Ouvrez **http://localhost:2138** dans votre navigateur
2. Accédez à **Connectors** dans la barre de navigation supérieure
3. Trouvez **Telegram** dans la liste des connecteurs et activez-le (**ON**)
4. Collez votre **Bot Token** (voir ci-dessous pour savoir comment en obtenir un)
5. Cliquez sur **Save Settings** — l'agent redémarrera automatiquement
6. Cliquez sur **Test Connection** pour vérifier — vous devriez voir "Connected as @yourbotname"
7. Ouvrez Telegram, trouvez votre bot par son nom d'utilisateur et envoyez `/start`

C'est tout — votre bot est en ligne.

<div id="getting-a-bot-token-from-botfather">
## Obtenir un token de bot auprès de BotFather
</div>

<Steps>
  <Step title="Créer un bot avec BotFather">
    Ouvrez Telegram et recherchez **@BotFather**, le bot officiel pour créer des bots Telegram.

    1. Démarrez une conversation avec @BotFather en cliquant sur le bouton "Start"
    2. Envoyez la commande : `/newbot`
    3. BotFather vous demandera de choisir un nom pour votre bot (c'est le nom affiché)
    4. Choisissez un nom d'utilisateur unique pour votre bot (doit se terminer par "bot")
    5. BotFather répondra avec votre **bot token** — conservez-le en lieu sûr

    <Warning>
      Ne partagez jamais votre token de bot publiquement et ne l'incluez pas dans le contrôle de version. Il donne un accès complet à votre bot.
    </Warning>

    Votre token ressemblera à quelque chose comme : `123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI`
  </Step>

  <Step title="Récupérer un token existant">
    Si vous avez déjà un bot, vous pouvez récupérer le token à tout moment :

    1. Envoyez un message à @BotFather avec `/mybots`
    2. Sélectionnez votre bot dans la liste
    3. Sélectionnez "API Token"

    Pour régénérer un token compromis, sélectionnez "Revoke current token" dans le même menu. Cela invalide immédiatement l'ancien token.
  </Step>
</Steps>

<div id="dashboard-features">
## Fonctionnalités du tableau de bord
</div>

<div id="test-connection">
### Tester la connexion
</div>

Après avoir enregistré votre token de bot, cliquez sur **Test Connection** dans les paramètres du connecteur. Cela appelle l'API Telegram `getMe` et vérifie que votre token est valide. Vous verrez l'un de ces résultats :

- **"Connected as @yourbotname"** — votre bot est prêt
- **"Telegram API error: ..."** — vérifiez votre token

<div id="chat-access-toggle">
### Contrôle d'accès aux conversations
</div>

Par défaut, votre bot est configuré sur **Allow all chats** — toute personne qui lui envoie un message recevra une réponse. Pour restreindre l'accès :

1. Cliquez sur le bouton **Allow all chats** pour passer à **Allow only specific chats**
2. Un champ de saisie apparaîtra — entrez un tableau JSON d'identifiants de conversation autorisés, par exemple :
   ```json
   ["123456789", "-1001234567890"]
   ```
3. Cliquez sur **Save Settings**

Pour revenir en arrière, cliquez à nouveau sur le bouton pour revenir à **Allow all chats** — vos identifiants de conversation précédemment enregistrés seront restaurés si vous repassez aux conversations spécifiques.

Formats d'identifiant de conversation :
- **Nombres positifs** (ex. `123456789`) — conversations privées avec des utilisateurs individuels
- **Nombres négatifs commençant par -100** (ex. `-1001234567890`) — groupes et supergroupes

Pour trouver votre identifiant de conversation, utilisez [@userinfobot](https://t.me/userinfobot) sur Telegram.

Les modifications des conversations autorisées prennent effet immédiatement — aucun redémarrage nécessaire.

<div id="show--hide-token">
### Afficher / Masquer le token
</div>

Cliquez sur le bouton **Show** à côté du champ Bot Token pour révéler la valeur du token enregistré. Cliquez sur **Hide** pour le masquer à nouveau.

<div id="reset">
### Réinitialiser
</div>

Cliquez sur **Reset** pour effacer tous les paramètres Telegram enregistrés (token, conversations autorisées, etc.). Cela demandera une confirmation et redémarrera l'agent. Vous devrez reconfigurer le connecteur ensuite.

<div id="advanced-settings">
### Paramètres avancés
</div>

Cliquez sur **Advanced** pour développer les paramètres supplémentaires :

- **API Root** — Point de terminaison personnalisé de l'API Bot Telegram (par défaut : `https://api.telegram.org`). Nécessaire uniquement si vous utilisez un [serveur d'API Bot local](https://core.telegram.org/bots/api#using-a-local-bot-api-server) ou un proxy.
- **Test Chat ID** — Identifiant de conversation utilisé par la suite de tests automatisés. Non nécessaire pour la production.

<div id="configuration-via-elizajson">
## Configuration via eliza.json
</div>

Vous pouvez également configurer le connecteur Telegram directement dans `~/.eliza/eliza.json` :

```json
{
  "env": {
    "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI"
  }
}
```

Ou utilisez un fichier `.env` à la racine de votre projet :

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI
```

Puis démarrez Eliza :

```bash
bun run dev
```

<div id="configuration-parameters">
## Paramètres de configuration
</div>

| Paramètre | Requis | Description |
|-----------|--------|-------------|
| **Bot Token** (`TELEGRAM_BOT_TOKEN`) | Oui | Token d'authentification de @BotFather. C'est le seul paramètre nécessaire pour démarrer. |
| **Allowed Chats** (`TELEGRAM_ALLOWED_CHATS`) | Non | Tableau JSON d'identifiants de conversation avec lesquels le bot peut interagir. S'il n'est pas défini, le bot répond à toutes les conversations. |
| **API Root** (`TELEGRAM_API_ROOT`) | Non | Point de terminaison personnalisé de l'API Bot Telegram. Par défaut : `https://api.telegram.org`. |
| **Test Chat ID** (`TELEGRAM_TEST_CHAT_ID`) | Non | Identifiant de conversation utilisé par la suite de tests E2E. Non nécessaire pour la production. |

<div id="troubleshooting">
## Dépannage
</div>

<AccordionGroup>
  <Accordion title="Le token du bot est invalide ou ne fonctionne pas">
    **Problème :** Vous obtenez une erreur comme "Unauthorized" ou le bouton Test Connection affiche "Telegram API error"

    **Solutions :**
    1. Vérifiez que vous avez copié l'intégralité du token correctement
    2. Confirmez que le token n'a pas été révoqué — consultez `/mybots` dans BotFather
    3. Assurez-vous qu'il n'y a pas d'espaces ou de sauts de ligne supplémentaires
    4. Régénérez le token dans BotFather si nécessaire (cela invalide l'ancien)
    5. Après avoir collé un nouveau token, cliquez sur **Save Settings** puis sur **Test Connection**
  </Accordion>

  <Accordion title="Le badge NEEDS SETUP ne disparaît pas">
    **Problème :** Le connecteur Telegram affiche "Needs setup" bien que le token soit enregistré

    **Solutions :**
    1. Seul le **Bot Token** est obligatoire — les autres champs sont optionnels
    2. Cliquez sur **Save Settings** pour enregistrer votre token
    3. Rafraîchissez la page — le badge devrait passer à "Ready"
    4. Si le badge persiste, vérifiez les messages d'erreur dans le terminal
  </Accordion>

  <Accordion title="Le bot ne reçoit pas de messages">
    **Problème :** Vous envoyez des messages mais le bot ne répond pas

    **Solutions :**
    1. Vérifiez que le connecteur est activé (**ON**) dans le tableau de bord
    2. Vérifiez que Test Connection affiche "Connected as @yourbotname"
    3. Recherchez les messages d'erreur dans le terminal où Eliza s'exécute
    4. Si l'accès aux conversations est restreint, vérifiez que votre identifiant de conversation est dans la liste autorisée
    5. Assurez-vous d'avoir envoyé `/start` au bot en premier
    6. Essayez de redémarrer Eliza — le connecteur pourrait avoir besoin d'un redémarrage
  </Accordion>

  <Accordion title="Le bot répond lentement">
    **Problème :** Les messages sont retardés ou le bot semble ne pas répondre

    **Solutions :**
    1. Vérifiez votre connexion internet
    2. Surveillez les ressources système — la RAM ou le CPU pourrait être saturé
    3. Vérifiez les journaux de Eliza pour les erreurs ou les processus bloqués
    4. Pour la production, envisagez le mode webhook au lieu du polling
  </Accordion>

  <Accordion title="Erreur 409 Conflict dans les journaux">
    **Problème :** Les journaux affichent "409: Conflict: terminated by other getUpdates request"

    **Solutions :**
    1. Assurez-vous qu'une seule instance de Eliza est en cours d'exécution
    2. Recherchez les processus de bot obsolètes : `tasklist | grep bun` (Windows) ou `ps aux | grep bun` (Linux/Mac)
    3. Attendez 30 secondes et redémarrez — Telegram a besoin de temps pour libérer le slot de polling
  </Accordion>
</AccordionGroup>

<div id="next-steps">
## Prochaines étapes
</div>

- **[Guide des connecteurs](../guides/connectors.md)** — Aperçu de tous les connecteurs disponibles
- **[Guide de configuration](../guides/config-templates.md)** — Options de configuration avancées
- **[Guide de déploiement](../guides/deployment.md)** — Déployez votre bot en production

<div id="need-help">
## Besoin d'aide ?
</div>

- Rejoignez la [Communauté Discord de Eliza](https://discord.gg/eliza)
- Signalez les problèmes sur [GitHub](https://github.com/eliza-ai/eliza/issues)
