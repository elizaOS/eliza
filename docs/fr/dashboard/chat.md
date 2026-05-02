---
title: Chat
sidebarTitle: Chat
description: L'interface de messagerie principale pour interagir avec votre agent Eliza — chat vocal, avatar 3D, conversations et surveillance autonome.
---

L'onglet Chat est la vue d'accueil par défaut du tableau de bord. Il fournit l'interface de messagerie principale via le composant `ChatView`, avec une disposition en trois colonnes : la barre latérale des conversations à gauche, la vue de chat au centre et le panneau autonome à droite.

<div id="message-area">
## Zone de messages
</div>

Les messages sont rendus via le composant `MessageContent`, qui prend en charge :

- **Texte brut** — messages de chat standard avec les retours à la ligne préservés.
- **Configuration de plugin en ligne** — les marqueurs `[CONFIG:pluginId]` dans les réponses de l'agent sont rendus comme des formulaires interactifs de configuration de plugin via `ConfigRenderer`.
- **Rendu UI Spec** — les blocs de code JSON délimités contenant des objets UiSpec sont rendus comme des éléments UI interactifs via `UiRenderer`.
- **Blocs de code** — blocs de code délimités avec coloration syntaxique.
- **Streaming** — les réponses de l'agent sont streamées token par token avec un indicateur de saisie visible. Le drapeau `chatFirstTokenReceived` suit l'arrivée du premier token.
- **Progression des actions (sémantique de remplacement)** — Lorsqu'une action appelle son callback plusieurs fois (même principe que les messages progressifs de Discord), l'API envoie des mises à jour SSE de type **instantané** pour que le **dernier** texte du callback remplace le précédent après le préfixe streamé du modèle, au lieu de concaténer chaque ligne de statut en un bloc. **Pourquoi :** Le statut en temps réel devrait ressembler à des **modifications en direct**, pas à du bruit accumulé. Voir [Callbacks d'action et streaming SSE](/fr/runtime/action-callback-streaming).

<div id="input-area">
## Zone de saisie
</div>

La zone de saisie du chat se trouve en bas de la vue :

- **Zone de texte auto-redimensionnable** — s'agrandit de 38 px à un maximum de 200 px pendant la saisie.
- **Pièces jointes image** — joignez des images via le bouton de sélection de fichier, le glisser-déposer dans la zone de chat, ou le collage depuis le presse-papiers. Les images en attente s'affichent en miniatures au-dessus de la saisie.
- **Dépôt de fichiers** — glissez et déposez des fichiers dans la zone de chat pour les partager avec l'agent. Un indicateur visuel de zone de dépôt apparaît pendant le glissement.
- **Envoyer / Arrêter** — le bouton envoyer soumet le message ; pendant que l'agent répond, un bouton arrêter apparaît pour annuler la génération.

<div id="voice-chat">
## Chat vocal
</div>

Chat vocal intégré alimenté par ElevenLabs ou TTS/STT du navigateur :

- La configuration vocale se charge automatiquement depuis la configuration de l'agent au montage.
- Le hook `useVoiceChat` gère le basculement du microphone, la lecture vocale de l'agent et l'état de parole qui pilote le lip-sync de l'avatar.
- Les modifications de configuration vocale dans Paramètres ou les vues Personnage sont synchronisées en temps réel via un événement DOM personnalisé `eliza:voice-config-updated`.

<div id="vrm-3d-avatar">
## Avatar 3D VRM
</div>

Un avatar 3D en direct rendu avec Three.js et `@pixiv/three-vrm` :

- L'avatar réagit à la conversation avec des animations au repos et des émotes.
- Sélectionnez parmi 8 modèles VRM intégrés via l'état `selectedVrmIndex`.
- Basculez la visibilité de l'avatar et la mise en sourdine de la voix de l'agent via les deux boutons de contrôle dans la section Contrôles de Chat du Panneau Autonome.

<div id="conversations-sidebar">
## Barre latérale des conversations
</div>

Le composant `ConversationsSidebar` gère plusieurs conversations :

- **Liste des conversations** — triée par la plus récemment mise à jour. Chaque entrée affiche le titre, un horodatage relatif (par ex., "il y a 5m", "il y a 2j") et un indicateur de non-lu pour les conversations avec de nouveaux messages.
- **Créer une nouvelle** — un bouton "Nouveau Chat" en haut crée un nouveau fil de conversation.
- **Renommer** — double-cliquez sur le titre d'une conversation pour passer en mode d'édition en ligne. Appuyez sur Entrée pour enregistrer ou Échap pour annuler.
- **Supprimer** — chaque conversation a un bouton de suppression qui supprime le fil de manière permanente.
- **Suivi des non-lus** — l'ensemble `unreadConversations` suit quelles conversations ont de nouveaux messages que l'utilisateur n'a pas encore consultés.

<div id="autonomous-panel">
## Panneau autonome
</div>

Affiché sur le côté droit de l'onglet Chat, le composant `AutonomousPanel` offre une visibilité en temps réel sur les opérations autonomes :

- **État actuel** — affiche la dernière "Pensée" (des flux assistant/évaluateur) et la dernière "Action" (des flux action/outil/fournisseur).
- **Flux d'événements** — un fil déroulant, en ordre chronologique inverse, des 120 derniers événements, codés par couleur selon le type :

| Type d'événement | Couleur |
|------------|-------|
| Événements heartbeat | Accent |
| Événements d'erreur | Rouge (danger) |
| Événements d'action, outil, fournisseur | Vert (succès) |
| Pensées de l'assistant | Accent |
| Autres événements | Gris atténué |

- **Tâches du Workbench** — tâches actives sur lesquelles l'agent travaille, affichées comme une liste de vérification.
- **Triggers** — déclencheurs programmés (intervalle, cron, unique) avec leur type, statut d'activation et nombre d'exécutions.
- **Tâches** — éléments de tâche suivis par l'agent, affichés comme une liste de vérification.
- **Contrôles de Chat** — en bas, basculement de la visibilité de l'avatar et mise en sourdine de la voix de l'agent, plus une fenêtre d'aperçu de l'avatar VRM (260-420 px de hauteur selon le viewport).

<div id="emote-picker">
## Sélecteur d'émotes
</div>

Déclenchez les émotes de l'avatar VRM avec le raccourci clavier **Cmd+E** (macOS) ou **Ctrl+E** (Windows/Linux). Le sélecteur propose 29 émotes réparties en 6 catégories :

| Catégorie | Émotes |
|----------|--------|
| **Greeting** | Wave, Kiss |
| **Emotion** | Crying, Sorrow, Rude Gesture, Looking Around |
| **Dance** | Dance Happy, Dance Breaking, Dance Hip Hop, Dance Popping |
| **Combat** | Hook Punch, Punching, Firing Gun, Sword Swing, Chopping, Spell Cast, Range, Death |
| **Idle** | Idle, Talk, Squat, Fishing |
| **Movement** | Float, Jump, Flip, Run, Walk, Crawling, Fall |

Chaque émote est représentée par un bouton icône cliquable. Les catégories sont affichées comme des onglets filtrables dans le sélecteur.

<div id="context-menu">
## Menu contextuel
</div>

Faites un clic droit sur les messages pour accéder à un menu contextuel permettant d'enregistrer des commandes ou d'effectuer des actions personnalisées.
