<div id="plugin-resolution-why-node_path-is-needed">
# Résolution des plugins : pourquoi NODE_PATH est nécessaire
</div>

Ce document explique **pourquoi** les imports dynamiques de plugins échouent sans `NODE_PATH` et **comment** nous le corrigeons dans le CLI, le dev server et Electrobun.

<div id="the-problem">
## Le problème
</div>

Le runtime (`src/runtime/eliza.ts`) charge les plugins via import dynamique :

```ts
import("@elizaos/plugin-sql")
```

Node résout cela en remontant depuis le **répertoire du fichier importateur**. Quand eliza s'exécute depuis différents emplacements, la résolution peut échouer :

| Point d'entrée | Emplacement du fichier importateur | Remonte depuis | Atteint le `node_modules` racine ? |
|---|---|---|---|
| `bun run dev` | `src/runtime/eliza.ts` | `src/runtime/` | Généralement oui (2 niveaux) |
| `eliza start` (CLI) | `dist/runtime/eliza.js` | `dist/runtime/` | Généralement oui (2 niveaux) |
| Electrobun dev | `eliza-dist/eliza.js` | `apps/app/electrobun/eliza-dist/` | **Non** — entre dans `apps/` |
| Electrobun empaqueté | `app.asar.unpacked/eliza-dist/eliza.js` | Dans le bundle `.app` | **Non** — système de fichiers différent |

Dans les cas Electrobun (et parfois le cas dist compilé selon le comportement du bundler), la remontée n'atteint jamais la racine du repo où les packages `@elizaos/plugin-*` sont installés. L'import échoue avec "Cannot find module".

<div id="the-fix-node_path">
## La correction : NODE_PATH
</div>

`NODE_PATH` est une variable d'environnement Node.js qui ajoute des répertoires supplémentaires à la résolution de modules. Nous la définissons en **trois endroits** pour que chaque chemin d'entrée résolve les plugins :

<div id="1-srcruntimeelizats-module-level">
### 1. `src/runtime/eliza.ts` (niveau module)
</div>

```ts
const _repoRoot = path.resolve(_elizaDir, "..", "..");
const _rootModules = path.join(_repoRoot, "node_modules");
if (existsSync(_rootModules)) {
  process.env.NODE_PATH = ...;
  Module._initPaths();
}
```

**Pourquoi ici :** Couvre `bun run dev` (dev-server.ts importe eliza directement) et tout autre import en processus d'eliza. La garde `existsSync` signifie que c'est un no-op dans les apps empaquetées où la racine du repo n'existe pas.

**Note sur `Module._initPaths()` :** C'est une API privée de Node.js mais largement utilisée exactement pour ce but (mutation de NODE_PATH au runtime). Node met en cache les chemins de résolution au démarrage ; après avoir défini `process.env.NODE_PATH`, nous devons l'appeler pour que le prochain `import()` voie les nouveaux chemins.

<div id="2-scriptsrun-nodemjs-child-process-env">
### 2. `scripts/run-node.mjs` (env du processus enfant)
</div>

```js
const rootModules = path.join(cwd, "node_modules");
env.NODE_PATH = ...;
```

**Pourquoi ici :** L'exécuteur CLI lance un processus enfant qui exécute `eliza.mjs` → `dist/entry.js` → `dist/eliza.js`. Définir `NODE_PATH` dans l'env de l'enfant assure que l'enfant résout depuis la racine même si `dist/` n'a pas son propre `node_modules`.

<div id="3-appsappelectrobunscrnativeagentts-electrobun-native-runtime">
### 3. `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` (runtime natif Electrobun)
</div>

```ts
// Dev: walk up from __dirname to find node_modules
// Packaged: use ASAR node_modules
```

**Pourquoi ici :** Le runtime natif Electrobun charge `eliza-dist/eliza.js` via `dynamicImport()`. En mode dev, `__dirname` est profond dans `apps/app/electrobun/build/src/native/` — nous remontons pour trouver le premier répertoire `node_modules` (la racine du monorepo). En mode empaqueté, nous utilisons le `node_modules` de l'ASAR à la place.

<div id="why-not-just-use-the-bundler">
## Pourquoi ne pas simplement utiliser le bundler ?
</div>

tsdown avec `noExternal: [/.*/]` inline la plupart des dépendances, mais les packages `@elizaos/plugin-*` sont chargés via **import dynamique au runtime** (le nom du plugin vient de la config, pas d'un import statique). Le bundler ne peut pas les inliner car il ne sait pas quels plugins seront chargés. Ils doivent être résolubles au runtime.

<div id="packaged-app-no-op">
## App empaquetée : no-op
</div>

Dans le `.app` empaqueté, `eliza.js` vit à `app.asar.unpacked/eliza-dist/eliza.js`. Deux niveaux au-dessus c'est `Contents/Resources/` — pas de `node_modules` là. La vérification `existsSync` dans `eliza.ts` retourne false, donc le code NODE_PATH est entièrement ignoré. L'app empaquetée copie plutôt les packages runtime dans `eliza-dist/node_modules` pendant le build bureau (`copy-runtime-node-modules.ts` pour Electrobun) et `agent.ts` définit ce répertoire `node_modules` empaqueté sur `NODE_PATH`.

<div id="bun-and-published-package-exports">
## Bun et les exports de packages publiés
</div>

Certains packages `@elizaos` (par ex. `@elizaos/plugin-sql`) publient un `package.json` avec `exports["."].bun = "./src/index.ts"`. **Pourquoi ils font ça :** Dans le monorepo upstream, Bun peut exécuter TypeScript directement, donc pointer vers `src/` évite une étape de build. Cependant, le tarball npm publié n'inclut que `dist/` — `src/` n'est pas livré. Quand nous installons depuis npm, la condition `"bun"` pointe vers un chemin qui n'existe pas.

**Ce qui se passe :** Le résolveur de Bun préfère la condition d'export `"bun"`. Il tente de charger `./src/index.ts`, le fichier est manquant, et nous obtenons "Cannot find module … from …/src/runtime/eliza.ts" même si le package est dans `node_modules`. Bun ne retombe pas sur la condition `"import"` quand la cible `"bun"` est manquante.

**Notre correction :** `scripts/patch-deps.mjs` s'exécute après `bun install` via `scripts/run-repo-setup.mjs` (utilisé par `postinstall` et le bootstrap de build de l'app). Il applique le correctif aux paquets `@elizaos` installés qui en ont besoin et, si `exports["."].bun` pointe vers `./src/index.ts` et que ce fichier n'existe pas, supprime les conditions `"bun"` et `"default"` qui référencent `src/`. Après le patch, seuls `"import"` (et similaires) restent, donc Bun résout vers `./dist/index.js`. **Pourquoi nous ne patchons que quand le fichier est manquant :** Dans un workspace de développement où le plugin est checké avec `src/` présent, nous laissons le package inchangé pour que les workflows upstream fonctionnent toujours.

<div id="pinned-elizaosplugin-openrouter">
## Épinglé : `@elizaos/plugin-openrouter`
</div>

Ce repo résout actuellement **`@elizaos/plugin-openrouter`** via un lien workspace local (**`workspace:*`**) pendant le développement. Lorsque le checkout local n'est pas utilisé, le `package.json` racine épingle **`2.0.0-alpha.13`** (le tarball npm connu comme fonctionnel actuel). **`2.0.0-alpha.12`** a livré des entrypoints dist cassés et doit être évité.

<div id="what-went-wrong-in-200-alpha12">
### Ce qui s'est mal passé dans `2.0.0-alpha.12`
</div>

Le tarball npm publié pour **`2.0.0-alpha.12`** contient des sorties JavaScript **tronquées** pour les entrypoints ESM Node et navigateur (`dist/node/index.node.js`, `dist/browser/index.browser.js`). Ces fichiers n'incluent que les helpers `utils/config` bundlés (~80 lignes). L'**implémentation principale du plugin** (l'objet qui devrait être exporté comme `openrouterPlugin` et comme `default`) **n'est pas présente** dans le fichier, mais la liste finale `export { … }` nomme toujours `openrouterPlugin` et `openrouterPlugin2 as default`.

**Pourquoi Bun erreur :** Quand le runtime charge le plugin, Bun build/transpile ce fichier d'entrée et échoue avec des erreurs comme *`openrouterPlugin` is not declared in this file* — les symboles sont exportés mais jamais définis. Le build CommonJS (`dist/cjs/index.node.cjs`) est incomplet de la même manière (les getters d'export référencent un chunk `import_plugin` manquant).

**Pourquoi nous ne patchons pas le dist en postinstall :** La release cassée manque le corps entier du plugin, pas un seul identifiant incorrect (contraste avec `@elizaos/plugin-pdf`, où un petit string replace corrige un mauvais alias d'export). Reconstruire le plugin depuis les sources dans Eliza forkerait upstream et serait fragile. Quand vous n'utilisez pas le checkout workspace local, préférez l'artefact **`2.0.0-alpha.13`** connu comme fonctionnel.

<div id="maintainer-notes">
### Notes pour les mainteneurs
</div>

- **Avant de mettre à jour** la dépendance OpenRouter, vérifiez le **tarball publié** sur npm : ouvrez `dist/node/index.node.js` et confirmez qu'il définit l'export default / `openrouterPlugin`, ou lancez `bun build node_modules/@elizaos/plugin-openrouter/dist/node/index.node.js --target=bun` après installation.
- **Ne remplacez pas le lien workspace par une plage semver non bornée** tant qu'upstream n'a pas publié une version corrigée et que vous n'avez pas confirmé l'artefact. **Pourquoi :** `^2.0.0-alpha.13` permettait à Bun de résoudre des versions défectueuses, ce qui cassait les installations qui mettaient à jour le lockfile.

Le contexte utilisateur et la configuration pour OpenRouter lui-même vivent dans **[Plugin OpenRouter](plugin-registry/llm/openrouter.md)** (Mintlify : `/plugin-registry/llm/openrouter`).

<div id="optional-plugins-why-was-this-package-in-the-load-set">
## Plugins optionnels : pourquoi ce package était-il dans le jeu de chargement ?
</div>

Les plugins optionnels (et certains packages adjacents au core) peuvent se retrouver dans le jeu de chargement à cause de **`plugins.allow`**, **`plugins.entries`**, la configuration des **connecteurs**, **`features.*`**, les **variables d'environnement** (par ex. clés API de fournisseur ou clés wallet qui déclenchent l'auto-activation), ou **`plugins.installs`**. Quand la résolution échoue avec **module npm manquant** ou **stagehand navigateur manquant**, le log ressemblait autrefois à une erreur runtime générique.

**Pourquoi nous enregistrons la provenance :** `collectPluginNames()` remplit optionnellement une carte **`PluginLoadReasons`** (première source gagne par package). `resolvePlugins()` la transmet ; les échecs optionnels bénins sont résumés comme **`Optional plugins not installed: … (added by: …)`**. Cela répond "que dois-je changer ?" — éditer la config, désactiver l'env, installer le package, ou ajouter un checkout du plugin — au lieu de poursuivre une fausse hypothèse "eliza est cassé".

**Browser / stagehand :** `@elizaos/plugin-browser` attend un arbre **stagehand-server** qui **n'est pas** dans le tarball npm. Eliza découvre `plugins/plugin-browser/stagehand-server` en **remontant les parents** depuis le runtime pour que les checkouts Eliza plats et les layouts de **sous-module `eliza/`** résolvent. Voir **[Diagnostics développeur et espace de travail](/fr/guides/developer-diagnostics-and-workspace)**.
