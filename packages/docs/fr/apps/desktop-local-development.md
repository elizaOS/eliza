---
title: Développement local du bureau
sidebarTitle: Développement local
description: Pourquoi et comment l'orchestrateur de développement bureau de Eliza (scripts/dev-platform.mjs) exécute Vite, l'API et Electrobun ensemble — variables d'environnement, signaux et comportement d'arrêt.
---

La **pile de développement bureau** n'est pas un seul binaire. `bun run dev:desktop` et `bun run dev:desktop:watch` exécutent `scripts/dev-platform.mjs`, qui **orchestre** des processus séparés : build unique optionnel `vite build`, `tsdown` optionnel à la racine du repo, puis **Vite** de longue durée (quand `ELIZA_DESKTOP_VITE_WATCH=1`), **`bun --watch` API**, et **Electrobun**.

**Pourquoi orchestrer ?** Electrobun a besoin (a) d'une URL de rendu, (b) souvent d'une API dashboard en cours d'exécution, et (c) en développement, d'un bundle `dist/` à la racine pour le runtime Eliza embarqué. Le faire manuellement est source d'erreurs ; un seul script maintient les ports, les variables d'environnement et l'arrêt cohérents.

<div id="commands">
## Commandes
</div>

**Flags CLI** (préférés pour l'usage ponctuel ; `bun run dev:desktop -- --help` les liste) : `--no-api`, `--force-renderer`, `--rollup-watch`, `--vite-force`.

| Commande | Ce qui démarre | Usage typique |
|----------|----------------|---------------|
| `bun run dev:desktop` | API (sauf `--no-api`) + Electrobun ; **saute** `vite build` quand `apps/app/dist` est plus récent que les sources | Itération rapide contre les assets de rendu **compilés** |
| `bun run dev:desktop:watch` | Même orchestrateur avec **`ELIZA_DESKTOP_VITE_WATCH=1`** — **Serveur de développement Vite** + HMR | Workflow UI bureau |
| `bun run dev` / `bun run dev:web:ui` | Pile dashboard navigateur uniquement (API + Vite) | Itération dashboard compatible headless |

**Tables de démarrage :** l'orchestrateur, Vite, l'API et Electrobun impriment chacun une **table de paramètres en texte brut** (colonnes *Setting / Effective / Source / Change*) pour que vous puissiez voir les valeurs par défaut vs environnement et comment modifier un réglage. Exécutez sans `--help` pour les voir dans le terminal.

<div id="startup-tables-and-terminal-banners">
### Tables de démarrage et bannières terminal
</div>

Sur un **TTY**, les tables peuvent utiliser un **cadre Unicode** et un grand titre style **figlet** pour le nom du sous-système (orchestrateur, Vite, API, Electrobun), avec **couleur ANSI** (titre magenta, cadre cyan) sauf si **`NO_COLOR`** est défini (**`FORCE_COLOR`** peut l'activer pour la sortie redirigée).

**Pourquoi :** Le développement bureau exécute **quatre processus** avec un environnement qui se chevauche (ports, URLs, flags de fonctionnalités). L'objectif est le **scan visuel rapide** des valeurs *effectives* pour les humains et les agents IDE — la même logique que la pré-allocation de ports et les logs préfixés. Ce n'est **pas** l'UI du companion ou du dashboard ; cela n'est pas livré aux utilisateurs finaux comme chrome produit.

**Docs :** [Diagnostics développeur et espace de travail](../guides/developer-diagnostics-and-workspace.md).

**Pourquoi des commandes séparées ?** Un build Vite complet de **production** reste utile quand vous voulez la parité avec les assets publiés ou quand vous ne touchez pas l'UI du shell bureau. `bun run dev:desktop:watch` pointe Electrobun vers le serveur de développement Vite pour le HMR, tandis que `bun run dev` reste sur la pile dashboard navigateur.

<div id="legacy-rollup-vite-build---watch">
### Legacy : Rollup `vite build --watch`
</div>

Si vous avez explicitement besoin d'une sortie fichier à chaque sauvegarde (par ex. débogage du comportement Rollup) :

```bash
ELIZA_DESKTOP_VITE_WATCH=1 bun scripts/dev-platform.mjs -- --rollup-watch
# or env-only:
ELIZA_DESKTOP_VITE_WATCH=1 ELIZA_DESKTOP_VITE_BUILD_WATCH=1 bun scripts/dev-platform.mjs
```

**Pourquoi c'est opt-in :** `vite build --watch` exécute toujours des émissions de production Rollup ; "3 modules transformed" peut signifier **des secondes** à réécrire des chunks de plusieurs Mo. Le chemin watch par défaut utilise le **serveur de développement Vite** à la place.

<div id="environment-variables">
## Variables d'environnement
</div>

| Variable | Objectif |
|----------|----------|
| `ELIZA_DESKTOP_VITE_WATCH=1` | Active le workflow watch (serveur de développement par défaut ; voir ci-dessous) |
| `ELIZA_DESKTOP_VITE_BUILD_WATCH=1` | Avec `VITE_WATCH`, utilise `vite build --watch` au lieu de `vite dev` |
| `ELIZA_PORT` | Port Vite / UI attendu (par défaut **2138**) |
| `ELIZA_API_PORT` | Port API (par défaut **31337**) ; transmis au proxy env Vite et Electrobun |
| `ELIZA_RENDERER_URL` | Défini **par l'orchestrateur** lors de l'utilisation de Vite dev — le `resolveRendererUrl()` d'Electrobun préfère ceci au serveur statique intégré (**pourquoi :** le HMR ne fonctionne que contre le serveur de développement) |
| `ELIZA_DESKTOP_RENDERER_BUILD=always` | Force `vite build` même quand `dist/` semble récent |
| `--force-renderer` | Équivalent à toujours recompiler le renderer |
| `--vite-force` | Passe `vite --force` au démarrage du serveur de développement Vite (vide le cache d'optimisation des deps) |
| `--rollup-watch` | Avec `ELIZA_DESKTOP_VITE_WATCH=1`, utilise `vite build --watch` au lieu de `vite dev` |
| `--no-api` | Electrobun uniquement ; pas d'enfant `dev-server.ts` |
| `ELIZA_DESKTOP_SCREENSHOT_SERVER` | **Actif par défaut** pour `dev:desktop` / `bun run dev` : Electrobun écoute sur `127.0.0.1:ELIZA_SCREENSHOT_SERVER_PORT` (par défaut **31339**) ; l'API Eliza fait proxy de **`GET /api/dev/cursor-screenshot`** (loopback) en **PNG plein écran** pour agents/outils (macOS nécessite la permission Screen Recording). Définir à **`0`**, **`false`**, **`no`**, ou **`off`** pour désactiver. |
| `ELIZA_DESKTOP_DEV_LOG` | **Actif par défaut :** les logs enfants (vite / api / electrobun) sont reflétés dans **`.eliza/desktop-dev-console.log`** à la racine du repo. **`GET /api/dev/console-log`** sur l'API (loopback) retourne un tail (`?maxLines=`, `?maxBytes=`). Définir à **`0`** / **`false`** / **`no`** / **`off`** pour désactiver. |

<div id="when-default-ports-are-busy">
### Quand les ports par défaut sont occupés
</div>

`scripts/dev-platform.mjs` exécute **`dev:desktop`** et **`bun run dev`**. Avant de démarrer les enfants de longue durée, il **sonde TCP en loopback** à partir de :

| Env | Rôle | Par défaut |
|-----|------|------------|
| **`ELIZA_API_PORT`** | API Eliza (`dev-server.ts`) | **31337** |
| **`ELIZA_PORT`** | Serveur de développement Vite (mode watch uniquement) | **2138** |

Si le port préféré est déjà utilisé, l'orchestrateur essaie **preferred + 1**, puis +2, … (plafonné), et passe les valeurs **résolues** à **chaque** enfant (`ELIZA_DESKTOP_API_BASE`, **`ELIZA_RENDERER_URL`**, **`ELIZA_PORT`** de Vite, etc.).

**Pourquoi pré-allouer dans le parent (pas seulement dans le processus API) :** Vite lit `vite.config.ts` une fois au démarrage ; le **`target`** du proxy doit correspondre au port API **avant** la première requête. Si seule l'API changeait de ports après le bind, l'UI ferait toujours proxy vers l'ancien défaut jusqu'à ce que quelqu'un relance Vite. Résoudre les ports **une fois** dans `dev-platform.mjs` garde **les logs de l'orchestrateur, l'env, le proxy et Electrobun** sur les mêmes numéros.

**Bureau empaqueté (agent `local` embarqué) :** le processus principal Electrobun appelle **`findFirstAvailableLoopbackPort`** (`apps/app/electrobun/src/native/loopback-port.ts`) depuis le **`ELIZA_PORT`** préféré (par défaut **2138**), le passe à l'enfant **`entry.js start`**, et après un démarrage sain met à jour **`process.env.ELIZA_PORT` / `ELIZA_API_PORT`** dans le shell. **Pourquoi nous avons arrêté `lsof` + SIGKILL par défaut :** une deuxième instance Eliza (ou toute app) sur le même port par défaut est valide quand les répertoires d'état diffèrent ; tuer des PIDs depuis le shell est surprenant et peut terminer du travail non lié. **Reclaim opt-in :** **`ELIZA_AGENT_RECLAIM_STALE_PORT=1`** exécute l'ancien comportement **"libérer ce port d'abord"** pour les développeurs qui veulent une prise de contrôle d'instance unique.

**Fenêtres détachées :** quand le port API embarqué est finalisé ou change, **`injectApiBase`** s'exécute pour la fenêtre principale et **toutes** les fenêtres `SurfaceWindowManager` (**pourquoi :** chat/settings/etc. ne doivent pas continuer à interroger un `http://127.0.0.1:…` obsolète).

**Voir aussi :** [Application bureau — Configuration des ports](./desktop#port-configuration) ; **`GET /api/dev/stack`** écrase **`api.listenPort`** depuis le **socket accepté** quand possible (**pourquoi :** la vérité bat l'env si quelque chose redirige le serveur).

<div id="macos-frameless-window-chrome-native-dylib">
## macOS : chrome de fenêtre sans cadre (dylib natif)
</div>

Sur **macOS**, Electrobun ne copie **`libMacWindowEffects.dylib`** dans le bundle de développement que si ce fichier existe (voir `apps/app/electrobun/electrobun.config.ts`). Sans lui, le **layout des feux tricolores, les zones de glissement et le redimensionnement de bord intérieur** peuvent manquer ou être incorrects — facile à confondre avec un bug générique d'Electrobun.

Après avoir cloné le repo, ou quand vous modifiez `native/macos/window-effects.mm`, compilez le dylib depuis le package Electrobun :

```bash
cd apps/app/electrobun && bun run build:native-effects
```

Plus de détails : [Package shell Electrobun](https://github.com/eliza-ai/eliza/tree/main/apps/app/electrobun) (README : *macOS window chrome*), et [Chrome de fenêtre macOS Electrobun](../guides/electrobun-mac-window-chrome.md).

<div id="macos-local-network-permission-gateway-discovery">
## macOS : permission Réseau Local (découverte de gateway)
</div>

Le shell bureau utilise **Bonjour/mDNS** pour découvrir les gateways Eliza sur votre LAN. macOS peut afficher un dialogue de confidentialité **Réseau Local** — choisissez **Autoriser** si vous dépendez de la découverte locale.

La configuration des types **Electrobun** épinglée par Eliza (à partir de la version dans ce repo) **n'expose pas** de merge `Info.plist` pour **`NSLocalNetworkUsageDescription`**, donc le système d'exploitation peut afficher un message générique. Si upstream ajoute ce hook plus tard, nous pourrons définir un texte plus clair ; le comportement n'en dépend pas.

<div id="why-vite-build-is-sometimes-skipped">
## Pourquoi `vite build` est parfois ignoré
</div>

Avant de démarrer les services, le script vérifie `viteRendererBuildNeeded()` (`scripts/lib/vite-renderer-dist-stale.mjs`) : compare le mtime de `apps/app/dist/index.html` avec `apps/app/src`, `vite.config.ts`, les packages partagés (`packages/ui`, `packages/app-core`), etc.

**Pourquoi mtime, pas un graphe complet de dépendances ?** C'est une **heuristique locale peu coûteuse** pour que les redémarrages ne paient pas 10–30s pour un build de production redondant quand les sources n'ont pas changé. Surchargez quand vous avez besoin d'un bundle propre.

<div id="signals-ctrl-c-and-detached-children-unix">
## Signaux, Ctrl-C et enfants `detached` (Unix)
</div>

Sur **macOS/Linux**, les enfants de longue durée sont lancés avec `detached: true` pour qu'ils vivent dans une **session séparée** de l'orchestrateur.

**Pourquoi :** Un **Ctrl-C** sur TTY est livré au **groupe de processus en premier plan**. Sans `detached`, Electrobun, Vite et l'API reçoivent tous **SIGINT** ensemble. Electrobun gère la première interruption ("press Ctrl+C again…") tandis que **Vite et l'API continuent de tourner** ; le parent reste en vie car les **pipes stdio** sont toujours ouverts — on a l'impression que le premier Ctrl-C "n'a rien fait."

Avec `detached`, **seul l'orchestrateur** reçoit le **SIGINT** du TTY ; il exécute un chemin d'arrêt unique : **SIGTERM** à chaque sous-arbre connu, courte grâce, puis **SIGKILL**, puis `process.exit`.

**Deuxième Ctrl-C** pendant l'arrêt **force la sortie** immédiatement (`exit 1`) pour que vous ne soyez jamais bloqué derrière un timer de grâce.

**Windows :** `detached` **n'est pas** utilisé de la même manière (stdio + modèle de processus diffèrent) ; le nettoyage de ports utilise `netstat`/`taskkill` au lieu de `lsof` seul.

<div id="quitting-from-the-app-electrobun-exits">
## Quitter depuis l'application (Electrobun se termine)
</div>

Si vous faites **Quit** depuis le menu natif, Electrobun se termine avec le code 0 tandis que **Vite et l'API peuvent encore tourner**. L'orchestrateur surveille l'enfant **electrobun** : à la sortie, il **arrête les services restants** et se termine.

**Pourquoi :** Sinon, la session terminal reste suspendue après "App quitting…" car le processus parent tient encore les pipes vers Vite/API — le même problème sous-jacent qu'un arrêt Ctrl-C incomplet.

<div id="port-cleanup-before-vite-killuilistenport">
## Nettoyage de ports avant Vite (`killUiListenPort`)
</div>

Avant de lier le port UI, le script tente de tuer ce qui écoute déjà (**pourquoi :** un Vite obsolète ou une exécution crashée laisse `EADDRINUSE`). Implémentation : `scripts/lib/kill-ui-listen-port.mjs` (Unix : `lsof` ; Windows : `netstat` + `taskkill`).

<div id="process-trees-and-kill-process-tree">
## Arbres de processus et `kill-process-tree`
</div>

L'arrêt utilise `signalSpawnedProcessTree` — **uniquement** l'arbre de PIDs enraciné à chaque enfant **généré** (**pourquoi :** éviter les nukes style `pkill bun` qui tueraient des espaces de travail Bun non liés sur la machine).

<div id="seeing-many-bun-processes">
## Voir beaucoup de processus `bun`
</div>

**Attendu.** Vous avez typiquement : l'orchestrateur, `bun run vite`, `bun --watch` API, `bun run dev` sous Electrobun (build preload + `bunx electrobun dev`), plus les internes Bun/Vite/Electrobun. Inquiétez-vous si les compteurs **augmentent sans limite** ou si les processus **survivent** après la fin complète de la session de développement.

<div id="ide-and-agent-observability-cursor-scripts">
## Observabilité IDE et agents (Cursor, scripts)
</div>

Les éditeurs et agents de codage **ne voient pas** la fenêtre native Electrobun, n'entendent pas l'audio, ni ne découvrent automatiquement localhost. Eliza ajoute des **hooks explicites et lisibles par machine** pour que les outils puissent raisonner sur "ce qui tourne" et approximer "ce que l'utilisateur voit."

**Pourquoi cela existe**

1. **Vérité multi-processus** — La santé n'est pas un seul PID. Vite, l'API et Electrobun peuvent diverger sur les ports ; les logs s'entrelacent. Un seul endpoint JSON et un fichier de log évitent "chercher dans cinq terminaux."
2. **Sécurité vs commodité** — Les endpoints screenshot et tail de logs sont **loopback uniquement** ; le chemin screenshot utilise un **token de session** entre Electrobun et le proxy API ; l'API de logs ne fait que tail d'un fichier nommé **`desktop-dev-console.log`**. **Pourquoi :** local-first ne signifie pas "n'importe quel processus sur le LAN peut obtenir votre écran."
3. **Défauts opt-out** — Screenshot et logging agrégé sont **actifs** pour `dev:desktop` / `bun run dev` car les agents et humains déboguant ensemble en bénéficient ; les deux se désactivent avec **`ELIZA_DESKTOP_SCREENSHOT_SERVER=0`** et **`ELIZA_DESKTOP_DEV_LOG=0`** pour réduire la surface d'attaque ou l'I/O disque.
4. **Cursor ne fait pas d'auto-poll** — La découverte est **documentation + `.cursor/rules`** (voir repo) plus vous demandant à l'agent d'exécuter `curl` ou lire un fichier. **Pourquoi :** le produit ne scanne pas silencieusement votre machine ; les hooks sont là quand on les demande.

<div id="get-apidevstack-eliza-api">
### `GET /api/dev/stack` (API Eliza)
</div>

Retourne du JSON stable (`schema: eliza.dev.stack/v1`) : **port d'écoute** API (depuis le **socket** quand possible), URLs/ports **bureau** depuis l'env (`ELIZA_RENDERER_URL`, `ELIZA_PORT`, …), disponibilité et chemins **`cursorScreenshot`** / **`desktopDevLog`**, et **hints** courts (par ex. le port RPC interne d'Electrobun dans les logs du launcher).

**Pourquoi sur l'API :** les agents interrogent souvent déjà `/api/health` ; un GET supplémentaire réutilise le même hôte et évite de parser le port éphémère d'Electrobun.

<div id="bun-run-desktopstack-status----json">
### `bun run desktop:stack-status -- --json`
</div>

Script : `scripts/desktop-stack-status.mjs` (avec `scripts/lib/desktop-stack-status.mjs`). Sonde les ports UI/API, récupère `/api/dev/stack`, `/api/health`, et `/api/status`.

**Pourquoi un CLI :** les agents et CI peuvent l'exécuter sans charger le dashboard ; le code de sortie JSON reflète la santé API pour une automatisation simple.

<div id="full-screen-png--get-apidevcursor-screenshot">
### PNG plein écran — `GET /api/dev/cursor-screenshot`
</div>

**Loopback uniquement.** Fait proxy du serveur de développement Electrobun (par défaut **`127.0.0.1:31339`**) qui utilise la même **capture au niveau OS** que `ScreenCaptureManager.takeScreenshot()` (par ex. macOS `screencapture`). **Pas** que les pixels du webview.

**Pourquoi proxy via l'API :** une URL sur le port API familier ; le token reste dans l'env entre les enfants générés par l'orchestrateur. **Pourquoi plein écran d'abord :** la capture par window-ID est spécifique à la plateforme ; ce chemin réutilise du code existant et testé.

<div id="aggregated-console--file--get-apidevconsolelog">
### Console agrégée — fichier + `GET /api/dev/console-log`
</div>

Les lignes préfixées **vite / api / electrobun** sont reflétées dans **`.eliza/desktop-dev-console.log`** (bannière de session à chaque démarrage de l'orchestrateur). **`GET /api/dev/console-log`** (loopback) retourne un **tail texte** ; query **`maxLines`** (par défaut 400, plafond 5000) et **`maxBytes`** (par défaut 256000).

**Pourquoi un fichier :** les agents peuvent `read_file` le chemin depuis `desktopDevLog.filePath` sans HTTP. **Pourquoi tail HTTP :** évite de lire des logs de plusieurs mégaoctets en contexte ; les plafonds préviennent les OOM. **Pourquoi liste de noms autorisés :** `ELIZA_DESKTOP_DEV_LOG_PATH` pourrait sinon pointer vers des fichiers arbitraires.

<div id="ui-e2e-playwright">
## E2E UI (Playwright)
</div>

Les tests smoke navigateur ciblent la **même URL de rendu** qu'Electrobun charge en mode watch (`http://localhost:<ELIZA_PORT>`, par défaut **2138**). Ils **ne contrôlent pas** le webview natif Electrobun ; le tray, les menus natifs et les comportements spécifiques au packaging restent couverts par **`bun run test:desktop:packaged`** (le cas échéant) et la [checklist de régression de release](./release-regression-checklist.md).

**Pourquoi Playwright :** l'app inclut déjà Playwright pour les vérifications de rendu et de packaging, donc les flux smoke navigateur utilisent maintenant la même pile supportée au lieu d'un toolchain TestCafe séparé. Cela supprime entièrement la dépendance vulnérable `replicator` et maintient la surface E2E UI sur un seul runner.

**Dépendance :** Playwright vit dans **`@elizaai/app`** et les specs smoke vivent dans `apps/app/test/ui-smoke/`. Un `bun install` normal à la racine élève toujours les packages du workspace ; ces vérifications navigateur sont opt-in via `test:ui:playwright*`.

**Runtime navigateur :** la suite utilise Playwright Chromium. Installez le navigateur une fois avec `cd apps/app && bunx playwright install chromium` s'il n'est pas déjà présent sur la machine.

| Commande | Objectif |
|----------|----------|
| `bun run test:ui:playwright` | Exécute [`apps/app/test/ui-smoke/ui-smoke.spec.ts`](../../apps/app/test/ui-smoke/ui-smoke.spec.ts) ; auto-démarre le renderer Vite sur **:2138** si nécessaire. |
| `bun run test:ui:playwright:settings-chat` | Exécute [`apps/app/test/ui-smoke/settings-chat-companion.spec.ts`](../../apps/app/test/ui-smoke/settings-chat-companion.spec.ts) pour la persistance des paramètres média du companion. |
| `bun run test:ui:playwright:packaged` | Exécute [`apps/app/test/ui-smoke/packaged-hash.spec.ts`](../../apps/app/test/ui-smoke/packaged-hash.spec.ts) contre `apps/app/dist/index.html` ; ignore si `dist` est absent. |

**Matrice de tests complète :** `bun run test` **n'exécute pas** les tests smoke Playwright UI par défaut. Définissez **`ELIZA_TEST_UI_PLAYWRIGHT=1`** pour ajouter la suite UI à `test/scripts/test-parallel.mjs` (séquentiel, après Vitest e2e). `ELIZA_TEST_UI_TESTCAFE=1` est toujours accepté comme alias legacy.

**Chemin A vs webview natif (Phase B) :** Ces specs ciblent toujours l'URL du renderer, pas le webview embarqué Electrobun. Les comportements packagés/natifs restent couverts par **`bun run test:desktop:packaged`**, **`bun run test:desktop:playwright`**, et la [checklist de régression de release](./release-regression-checklist.md).

<div id="related-source">
## Sources liées
</div>

| Pièce | Rôle |
|-------|------|
| `.cursor/rules/eliza-desktop-dev-observability.mdc` | Cursor : quand utiliser les hooks stack / screenshot / console (**pourquoi :** le produit ne scanne pas automatiquement localhost) |
| `scripts/dev-platform.mjs` | Orchestrateur ; définit l'env pour stack / screenshot / chemin de log |
| `scripts/lib/vite-renderer-dist-stale.mjs` | Quand `vite build` est nécessaire |
| `scripts/lib/kill-ui-listen-port.mjs` | Libérer le port UI |
| `scripts/lib/kill-process-tree.mjs` | Kill d'arbre ciblé |
| `scripts/lib/desktop-stack-status.mjs` | Sondes port + HTTP pour `desktop:stack-status` |
| `scripts/desktop-stack-status.mjs` | Entrée CLI pour agents (`--json`) |
| `packages/app-core/src/api/dev-stack.ts` | Payload pour `GET /api/dev/stack` |
| `packages/app-core/src/api/dev-console-log.ts` | Lecture tail sécurisée pour `GET /api/dev/console-log` |
| `apps/app/electrobun/src/index.ts` | `resolveRendererUrl()` ; démarre le serveur screenshot dev quand activé |
| `apps/app/electrobun/src/screenshot-dev-server.ts` | Serveur PNG loopback (proxy comme `/api/dev/cursor-screenshot`) |
| `apps/app/playwright.ui-smoke.config.ts` | Config Playwright pour les specs smoke renderer |
| `apps/app/playwright.ui-packaged.config.ts` | Config Playwright pour smoke `file://` packagé |
| `apps/app/test/ui-smoke/ui-smoke.spec.ts` | Parcours UI principal + parité `TAB_PATHS` (par ex. `/apps` désactivé) |
| `apps/app/test/ui-smoke/settings-chat-companion.spec.ts` | Persistance des paramètres média companion |
| `apps/app/test/ui-smoke/packaged-hash.spec.ts` | Parité `file://` + hash routing |

<div id="see-also">
## Voir aussi
</div>

- [Application bureau (Electrobun)](/fr/apps/desktop) — modes runtime, IPC, téléchargements
- [Démarrage et gestion des exceptions Electrobun](../electrobun-startup.md) — pourquoi le try/catch du processus principal reste
