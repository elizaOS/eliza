<div id="electrobun-desktop-app-startup-and-exception-handling">
# Application bureau Electrobun : démarrage et gestion des exceptions
</div>

Ce document explique comment l'agent embarqué démarre dans l'application bureau empaquetée et **pourquoi** les gardes de gestion d'exceptions dans `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` ne doivent pas être supprimées.

<div id="startup-sequence">
## Séquence de démarrage
</div>

1. **Processus principal Electrobun** démarre, crée la fenêtre et résout l'URL du renderer (serveur de développement Vite via `ELIZA_RENDERER_URL` ou le serveur d'assets statiques intégré pour `apps/app/dist` empaqueté).
2. **`AgentManager.start()`** (dans `native/agent.ts`) lance un **processus enfant Bun** : `bun run <eliza-dist>/entry.js start` (ou le chemin équivalent pour votre layout de bundle). L'enfant n'est **pas** un import dynamique en processus de `server.js` / `eliza.js`.
3. **Processus enfant** démarre le point d'entrée CLI de Eliza, lance le serveur API et exécute le runtime elizaOS en mode headless dans ce processus.
4. **Processus principal** interroge la santé sur `http://127.0.0.1:{port}/api/health` jusqu'à ce que l'enfant signale qu'il est prêt (ou timeout / erreurs).
5. **Processus principal** envoie `apiBaseUpdate` (et RPC associé) au renderer pour que `window.__ELIZA_API_BASE__` corresponde à l'API active.

Si l'enfant échoue au démarrage ou ne devient jamais sain :

- La **fenêtre Electrobun reste ouverte** pour que l'utilisateur ne se retrouve pas avec un shell vide.
- L'**état** est défini à `state: "error"` avec un message d'erreur pour que l'UI puisse afficher **Agent unavailable: …** au lieu d'un générique **Failed to fetch**.

Pour l'**orchestration de développement** (Vite + API + Electrobun dans des processus séparés), voir [Développement local du bureau](./apps/desktop-local-development.md).

<div id="why-the-guards-exist">
## Pourquoi les gardes existent
</div>

**Objectif :** Quand le runtime échoue au chargement (par ex. binaire natif manquant), l'utilisateur doit voir une erreur claire dans l'UI, pas une fenêtre morte. Cela nécessite (1) que le processus principal et le renderer restent actifs, et (2) des mises à jour d'état / RPC pour que l'UI puisse afficher **Agent unavailable: …**.

Sans gestion explicite :

1. Si le **processus enfant plante** ou que la santé ne réussit jamais, le processus principal doit exposer cela comme état **error** au renderer.
2. Si le **`start()` externe** détruisait la fenêtre ou supposait que l'API vivait en processus, le renderer pourrait perdre la **base API** et afficher **Failed to fetch** sans explication.

C'est pourquoi nous maintenons :

- **Isolation du processus enfant** — Les échecs API + runtime sont contenus dans l'enfant ; le processus principal observe les codes de sortie / la santé.
- **try/catch et `.catch()` là où c'est encore applicable** — Toute voie asynchrone restante qui pourrait rejeter doit définir l'état **error** au lieu de laisser l'UI non initialisée.
- **Voies externes qui NE doivent PAS tuer le shell** quand l'objectif est de montrer une erreur dans l'app — aligné avec les commentaires de `native/agent.ts` et ce document.

<div id="do-not-remove-as-excess">
## Ne pas supprimer comme "excès"
</div>

Les revues de code ou les passes automatisées de "deslop" suppriment parfois les try/catch ou `.catch()` comme "redondants" ou "gestion d'exceptions excessive." Dans ce module, ces gardes sont **intentionnelles** : elles maintiennent la fenêtre de l'application utilisable quand le runtime échoue au chargement. Les supprimer ramènerait le comportement cassé (fenêtre morte, **Failed to fetch**, pas de message d'erreur).

Le fichier et les sites clés dans `agent.ts` incluent des commentaires **WHY** qui référencent ce document. Lors de l'édition de ce fichier, préservez les gardes et la justification.

<div id="logs">
## Logs
</div>

L'application empaquetée écrit un log de démarrage dans :

- **macOS :** `~/Library/Application Support/Eliza/eliza-startup.log`
- **Windows :** `%APPDATA%\Eliza\eliza-startup.log`
- **Linux :** `~/.config/Eliza/eliza-startup.log`

Utilisez-le pour déboguer les échecs de chargement (modules manquants, chemin du binaire natif, etc.).

<div id="see-also">
## Voir aussi
</div>

- [Résolution des plugins et NODE_PATH](./plugin-resolution-and-node-path.md) — pourquoi les imports dynamiques de plugins ont besoin de `NODE_PATH` et où il est défini.
- [Build et release](./build-and-release.md) — Pipeline CI, builds Rosetta, copie de plugins/deps.
