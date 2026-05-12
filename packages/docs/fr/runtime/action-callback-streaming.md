---
title: Callbacks d'action et streaming SSE
description: Pourquoi Eliza remplace (au lieu de concaténer) le texte des callbacks d'action dans le chat du tableau de bord, et comment cela correspond aux messages progressifs à la Discord.
---

<div id="action-callbacks-and-sse-streaming">
# Callbacks d'action et streaming SSE
</div>

Le chat du tableau de bord de Eliza utilise les **Server-Sent Events (SSE)** pour streamer la réponse de l'assistant. Deux types de texte différents arrivent sur le même flux :

1. **Tokens LLM** — la réponse streamée du modèle (`onStreamChunk`).
2. **Callbacks d'action** — texte renvoyé par `HandlerCallback` pendant l'exécution d'une action (par ex. `PLAY_AUDIO`, flux de portefeuille, fallbacks de compétences Binance).

Cette page explique **comment ils sont fusionnés** et **pourquoi** cette conception correspond aux plateformes comme Discord et Telegram.

---

<div id="the-problem-we-solved">
## Le problème que nous avons résolu
</div>

Sur **Discord**, `@elizaos/plugin-discord` utilise un **message progressif** : un message est créé dans le canal, puis **modifié sur place** à mesure que les mises à jour de statut arrivent ("Looking up track…", "Searching…", "Now playing: …").

Sur **le web**, chaque `callback({ text })` passait auparavant par le même chemin de fusion que les fragments streamés arbitraires. Les chaînes de statut non liées ne partagent pas de préfixe commun, donc l'heuristique de fusion les **concaténait** souvent :

```text
🔍 Looking up track...🔍 Searching for track...✨ Setting up playback...Now playing: **Song**
```

C'est correct pour les **deltas de tokens** qui prolongent la même réponse, mais incorrect pour les **statuts successifs** qui devraient **remplacer** le statut précédent.

**Pourquoi c'est important :** Les utilisateurs s'attendent à des **mises à jour en direct, sur place** (temps réel style web2), pas à une pile croissante de fragments de statut. Les plugins ne devraient pas avoir besoin d'un second transport (WebSocket, événements personnalisés) juste pour atteindre la parité avec Discord.

---

<div id="the-eliza-behavior">
## Le comportement de Eliza
</div>

Dans `generateChatResponse` (`eliza/packages/agent/src/api/chat-routes.ts`) :

- Les **fragments LLM** utilisent toujours la sémantique d'**ajout** via `appendIncomingText` → `resolveStreamingUpdate` → `onChunk`.
- Les **callbacks d'action** utilisent **`replaceCallbackText`** :
  - Au **premier** callback d'un tour, le serveur prend un instantané de ce qui a déjà été streamé (`preCallbackText` — généralement le texte partiel ou final du LLM).
  - Chaque callback **suivant** définit la réponse visible à :

    `preCallbackText + "\n\n" + latestCallbackText`

  - Ainsi le **segment du callback** est **remplacé** à chaque fois ; le préfixe LLM est préservé.

La couche HTTP émet un **instantané** (`onSnapshot`) pour que l'événement SSE contienne le **nouveau** `fullText` complet. Le client traite déjà `fullText` comme faisant autorité et **remplace** le texte de la bulle de l'assistant — aucune modification de l'UI n'a été nécessaire.

**Pourquoi un instantané :** Le parseur SSE du frontend utilise `fullText` quand il est présent ; remplacer l'intégralité du message de l'assistant est O(1) pour l'UI et correspond mentalement à "modifier le corps du message".

**Pourquoi des chemins séparés LLM vs callback :** Le streaming LLM est véritablement incrémental (ajout). La progression des actions est un **remplacement d'état** (le dernier statut l'emporte). Mélanger les deux dans une seule fonction de fusion brouillait ces sémantiques.

---

<div id="plugin-contract-unchanged">
## Contrat des plugins (inchangé)
</div>

Les plugins doivent continuer à utiliser la forme `HandlerCallback` d'**elizaOS** :

```typescript
await callback({ text: "🔍 Searching…", source: message.content.source });
await callback({ text: "Now playing: **Track**", source: message.content.source });
```

Pas de champs supplémentaires, pas d'API spécifiques à Eliza, pas d'attachement au runtime. Les helpers comme `ProgressiveMessage` dans `plugin-music-player` restent une fine couche au-dessus de `callback`.

**Pourquoi préserver le contrat :** Discord et les autres connecteurs dépendent déjà de cette API ; le rôle de Eliza est d'interpréter correctement les callbacks répétés dans le chemin du **chat API**, pas de bifurquer la surface du plugin.

---

<div id="where-it-applies">
## Où cela s'applique
</div>

`replaceCallbackText` est câblé pour :

- Le callback d'action principal de `messageService.handleMessage`.
- `executeFallbackParsedActions` (récupération des actions parsées).
- Le dispatch direct des compétences Binance (`maybeHandleDirectBinanceSkillRequest`).
- Le fallback d'exécution du portefeuille et les chemins similaires qui invoquent des actions avec des callbacks.

**Non** utilisé pour `onStreamChunk` — celui-ci reste en mode ajout uniquement.

---

<div id="related-code-and-docs">
## Code et documentation associés
</div>

- **Implémentation :** `eliza/packages/agent/src/api/chat-routes.ts` — `replaceCallbackText`, `preCallbackText`.
- **Helper d'exemple :** `plugins/plugin-music-player/src/utils/progressiveMessage.ts`.
- **Streaming UI :** [Tableau de bord — Chat](/fr/dashboard/chat) (SSE / indicateur de saisie).
- **Journal des modifications :** [Journal des modifications](/fr/changelog) — recherchez "action callback" ou la date de publication.

---

<div id="future--roadmap">
## Futur / feuille de route
</div>

Suites possibles (non livrées comme exigences ici) :

- **Métadonnées** optionnelles sur le contenu du callback pour distinguer "ajout" vs "remplacement" pour les plugins exotiques (seulement si un cas d'utilisation réel apparaît).
- **Persistance** des statuts intermédiaires (aujourd'hui le texte du tour persisté suit les règles normales de persistance du chat).

Consultez `docs/roadmap.md` dans le dépôt pour la direction générale du produit.
