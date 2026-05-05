---
title: Diagnostics développeur et outillage workspace
---

# Diagnostics développeur et outillage workspace (POURQUOI)

Ce guide est destiné aux **personnes qui compilent Eliza depuis les sources** — éditeurs, agents et mainteneurs. Il explique **pourquoi** certains comportements récents orientés développeur existent afin que vous puissiez déboguer plus rapidement sans confondre du bruit optionnel avec des bugs produit.

<div id="plugin-load-reasons-optional-plugins">
## Raisons de chargement des plugins (plugins optionnels)
</div>

**Problème :** Des journaux comme `Cannot find module '@elizaos/plugin-solana'` ou "browser server not found" donnaient l'impression que le runtime était cassé, alors que souvent le vrai problème était que la **configuration ou une variable d'environnement** ajoutait un plugin à l'ensemble de chargement alors que le package ou le binaire natif n'avait jamais été installé.

**Pourquoi nous traçons la provenance :** `collectPluginNames()` peut enregistrer la **première** source ayant ajouté chaque package (par exemple `plugins.allow["@elizaos/plugin-solana"]`, `env: SOLANA_PRIVATE_KEY`, `features.browser`, `CORE_PLUGINS`). `resolvePlugins()` transmet cette map à travers la résolution ; quand un plugin **optionnel** échoue pour une raison bénigne (module npm manquant, stagehand manquant), le résumé du journal inclut **`(added by: …)`** pour que vous sachiez s'il faut modifier `eliza.json`, désactiver une variable d'environnement, installer un package ou ajouter un checkout de plugin.

**Portée :** Ce sont des **diagnostics**, pas une dissimulation d'erreurs. Les erreurs de résolution sérieuses continuent de s'afficher normalement.

**Code associé :** `eliza/packages/agent/src/runtime/plugin-collector.ts`, `eliza/packages/agent/src/runtime/plugin-resolver.ts`. Voir aussi [Résolution de plugins et NODE_PATH](/fr/plugin-resolution-and-node-path#optional-plugins-why-was-this-package-in-the-load-set).

<div id="browser--stagehand-server-path">
## Chemin du serveur browser / stagehand
</div>

**Problème :** `@elizaos/plugin-browser` attend un arbre binaire **stagehand-server** sous `dist/server/` dans le package npm, mais le tarball publié ne le contient pas. Eliza lie ou découvre un checkout sous `plugins/plugin-browser/stagehand-server/`.

**Pourquoi la remontée par les parents :** Le fichier runtime se trouve à différentes profondeurs (`eliza/packages/agent/...` vs `eliza/packages/agent/...` avec un sous-module). Une profondeur fixe `../` manquait la racine du workspace. **`findPluginBrowserStagehandDir()`** remonte les répertoires parents jusqu'à trouver `plugins/plugin-browser/stagehand-server` avec `dist/index.js` ou `src/index.ts`.

**Note opérationnelle :** Si vous n'utilisez pas l'automatisation du navigateur, l'absence de stagehand est **attendue** ; les messages sont intentionnellement concis au niveau débogage pour ne pas spammer le développement quotidien.

**Associé :** `scripts/link-browser-server.mjs`, `eliza/packages/agent/src/runtime/eliza.ts` (`ensureBrowserServerLink`, `findPluginBrowserStagehandDir`).

<div id="life-ops-schema-migrations-pglite">
## Migrations de schéma life-ops (PGlite)
</div>

**Problème :** Sur **PGlite** / Postgres, `SAVEPOINT` ne fonctionne que dans une transaction ; les appels ad hoc `executeRawSql` utilisent l'autocommit par défaut. Les migrations imbriquées qui utilisaient des savepoints sans un `BEGIN`/`COMMIT` externe échouaient ou se comportaient de manière incohérente.

**Pourquoi des transactions explicites :** `runMigrationWithSavepoint()` encapsule chaque migration nommée dans `BEGIN` → `SAVEPOINT` → … → `RELEASE`/`ROLLBACK TO` → `COMMIT` (ou `ROLLBACK` en cas d'échec externe). Cela correspond à la sémantique Postgres et maintient le comportement SQLite valide également.

**Index vs `ALTER TABLE` :** Les index sur `life_task_definitions` et les tables associées font référence aux **colonnes de propriété** (`domain`, `subject_type`, …). **Pourquoi les index s'exécutent après les ALTERs :** les bases de données héritées créées avant l'existence de ces colonnes échoueraient au `CREATE INDEX` si les index s'exécutaient dans le même lot que le `CREATE TABLE` initial sans les colonnes présentes. Les instructions d'index principaux sont appliquées **après** les étapes `ALTER TABLE` / remplissage de propriété.

**Tests :** `packages/agent/test/lifeops-pglite-schema.test.ts` couvre les chemins de mise à jour hérités.

<div id="workspace-dependency-scripts">
## Scripts de dépendances workspace
</div>

**Problème :** Les monorepos qui mélangent **`workspace:*`**, des plages semver publiées et des checkouts locaux `./eliza` / `plugins/*` dérivent facilement. Les modifications manuelles de `package.json` sont sujettes aux erreurs et difficiles à reviewer.

**Pourquoi les scripts existent :**

| Script / commande npm | Rôle |
|----------------------|------|
| `workspace:deps:sync` (`fix-workspace-deps.mjs`) | Normaliser les dépendances workspace vers une forme cohérente après des changements upstream ou locaux. |
| `workspace:deps:check` / `--check` | Vérifier sans écrire — CI ou pre-commit. |
| `workspace:deps:restore` | Restaurer les références `workspace:*` lorsque approprié. |
| `workspace:replace-versions` / `workspace:restore-refs` | Opérations ciblées sur les chaînes de version alignées avec les patterns d'outillage upstream d'eliza. |
| `workspace:prepare` | Étape de préparation séquencée pour les checkouts frais ou après des changements de branche. |

**Découverte :** `scripts/lib/workspace-discovery.mjs` centralise la façon dont nous trouvons les racines workspace et les packages de plugins afin que les scripts ne dupliquent pas de logique de chemins fragile.

<div id="terminal-dev-banners-orchestrator-vite-api-electrobun">
## Bannières terminal en développement (orchestrateur, Vite, API, Electrobun)
</div>

**Quoi :** Sur les TTYs, le démarrage peut afficher un **tableau de paramètres encadré Unicode** plus un **grand en-tête style figlet** par sous-système (orchestrateur, Vite, API, Electrobun), avec du **ANSI cyan/magenta** quand la couleur est autorisée (`NO_COLOR` / `FORCE_COLOR` respectés).

**Pourquoi ce n'est pas de l'"UI produit" :** La sortie est **stdout pour le développement local uniquement** — même catégorie que les tableaux de ports et les préfixes de journaux. **Objectif :** balayage visuel plus rapide par les humains/agents de l'**environnement effectif** (ports, feature flags, sources) quand quatre processus démarrent. Cela ne modifie pas le rendu du tableau de bord, du chat ou du companion.

**Emplacement :** `packages/shared` (helpers table + couleur + figlet), `scripts/dev-platform.mjs`, `apps/app/vite.config.ts`, `packages/app-core/src/runtime/dev-server.ts`, helper de bannière Electrobun sous `apps/app/electrobun/src/`.

**Documentation associée :** [Développement local bureau](/fr/apps/desktop-local-development#startup-tables-and-terminal-banners).

<div id="gitignored-local-artifacts">
## Artefacts locaux ignorés par git
</div>

**`cache/audio/`** — Les caches TTS ou médias locaux peuvent devenir volumineux ; ils ne font **pas** partie de l'arbre source.

**`scripts/bin/*` (sauf `.gitkeep`)** — Emplacement optionnel pour déposer des outils (p. ex. `yt-dlp`) pour le `PATH` dans les scripts de développement Electrobun. **Pourquoi ne pas commiter les binaires :** taille, variance de plateforme et cycle de vie des licences/mises à jour appartiennent à la machine du développeur, pas à git.

---

Voir le [Journal des modifications](/fr/changelog) pour les dates de livraison et la [Feuille de route](/fr/ROADMAP) pour les suivis.
