---
title: Guide de contribution
description: Comment configurer un environnement de développement, suivre les conventions de code et soumettre des pull requests au projet Eliza.
---

<div id="contributing-guide">
# Guide de contribution
</div>

Bienvenue dans Eliza ! Ce guide vous aidera à configurer votre environnement de développement et à contribuer efficacement.

<div id="table-of-contents">
## Table des matières
</div>

1. [Premiers pas](#getting-started)
2. [Environnement de développement](#development-environment)
3. [Structure du projet](#project-structure)
4. [Build et tests](#building-and-testing)
5. [Style de code](#code-style)
6. [Processus de pull request](#pull-request-process)
7. [Communauté](#community)

---

<div id="getting-started">
## Premiers pas
</div>

<div id="prerequisites">
### Prérequis
</div>

- **Node.js 22 LTS** — Runtime requis (`.nvmrc` est épinglé)
- **Bun** — Gestionnaire de paquets/runtime utilisé par les scripts du repo
- **Git** — Contrôle de version

<div id="quick-setup">
### Configuration rapide
</div>

```bash
# Clone the repository
git clone https://github.com/eliza-ai/eliza.git
cd eliza

# Match repository Node version
nvm use || nvm install
node -v  # expected: v22.22.0

# Install dependencies
bun install

# Build the project
bun run build

# Run in development mode
bun run dev
```

---

<div id="development-environment">
## Environnement de développement
</div>

<div id="required-tools">
### Outils requis
</div>

| Outil | Version | Objectif |
|-------|---------|----------|
| Node.js | 22.x LTS | Runtime |
| Bun | Dernière | Gestion des paquets + exécuteur de scripts |
| Git | Dernière | Contrôle de version |

<div id="optional-tools">
### Outils optionnels
</div>

| Outil | Objectif |
|-------|----------|
| bun | Gestionnaire de paquets optionnel pour les workflows hors repo |
| Docker | Tests en conteneur |
| VS Code | Éditeur recommandé |

<div id="editor-setup">
### Configuration de l'éditeur
</div>

**Extensions VS Code :**
- ESLint
- Prettier
- TypeScript
- Biome (pour le formatage)

**Paramètres (.vscode/settings.json) :**
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

---

<div id="monorepo-structure">
## Structure du monorepo
</div>

Eliza est un monorepo géré avec Turborepo et les workspaces Bun.

```
eliza/
├── packages/                # Shared packages
│   ├── typescript/          # @elizaos/core — Core TypeScript SDK
│   ├── elizaos/             # CLI tool (eliza command)
│   ├── skills/              # Skills system and bundled skills
│   ├── docs/                # Documentation site (Mintlify)
│   ├── schemas/             # Protobuf schemas
│   └── tui/                 # Terminal UI (disabled)
├── plugins/                 # Official plugins (100+)
│   ├── plugin-anthropic/    # Anthropic model provider
│   ├── plugin-telegram/     # Telegram connector
│   ├── plugin-discord/      # Discord connector
│   └── ...
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   └── ...                  # No shipped chrome-extension app in this release checkout
├── src/                     # Eliza runtime
│   ├── runtime/             # elizaOS runtime bootstrap
│   ├── plugins/             # Built-in Eliza plugins
│   ├── config/              # Configuration loading
│   ├── services/            # Registry client, plugin manager
│   └── api/                 # REST API server
├── skills/                  # Workspace skills
├── docs/                    # Documentation (this site)
├── scripts/                 # Build and utility scripts
├── test/                    # Test setup, helpers, e2e
├── AGENTS.md                # Repository guidelines
├── plugins.json             # Plugin registry manifest
└── tsdown.config.ts         # Build config
```

<div id="turbo-build-system">
### Système de build Turbo
</div>

Turborepo orchestre les builds sur tous les paquets avec un cache basé sur les dépendances :

```bash
# Build everything (with caching)
turbo run build

# Build a specific package
turbo run build --filter=@elizaos/core

# Build a package and all its dependencies
turbo run build --filter=@elizaos/plugin-telegram...

# Run tests across all packages
turbo run test

# Lint all packages
turbo run lint
```

<div id="key-entry-points">
### Points d'entrée clés
</div>

| Fichier | Objectif |
|---------|----------|
| `src/entry.ts` | Point d'entrée CLI |
| `src/index.ts` | Exports de librairie |
| `src/runtime/eliza.ts` | Initialisation du runtime elizaOS |
| `src/runtime/eliza-plugin.ts` | Plugin principal Eliza |
| `eliza.mjs` | Entrée bin npm |

---

<div id="building-and-testing">
## Build et tests
</div>

<div id="build-commands">
### Commandes de build
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# TypeScript only
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile (Android)
bun run build:android

# Mobile (iOS)
bun run build:ios
```

<div id="development-mode">
### Mode développement
</div>

```bash
# Run with auto-reload on changes
bun run dev

# Run CLI directly (via tsx)
bun run eliza start

# UI development only
bun run dev:ui

# Desktop app development
bun run dev:desktop
```

<div id="testing">
### Tests
</div>

Les seuils de couverture sont appliqués depuis `scripts/coverage-policy.mjs` : 25% lignes/fonctions/déclarations, 15% branches. La CI échoue quand la couverture tombe en dessous de ces planchers.

```bash
# Run all tests (parallel)
bun run test

# Run with coverage (enforces thresholds)
bun run test:coverage

# Watch mode
bun run test:watch

# End-to-end tests
bun run test:e2e

# Live tests (requires API keys)
ELIZA_LIVE_TEST=1 bun run test:live

# Docker-based tests
bun run test:docker:all
```

<div id="runtime-fallback-for-bun-crashes">
### Fallback runtime pour les crashes de Bun
</div>

Si Bun fait un segfault sur votre plateforme pendant les sessions longues, exécutez Eliza sur le runtime Node :

```bash
ELIZA_RUNTIME=node bun run eliza start
```

<div id="test-file-conventions">
### Conventions des fichiers de test
</div>

| Pattern | Objectif |
|---------|----------|
| `*.test.ts` | Tests unitaires (colocalisés avec le source) |
| `*.e2e.test.ts` | Tests end-to-end |
| `*.live.test.ts` | Tests d'API en direct |
| `test/**/*.test.ts` | Tests d'intégration |

<div id="packagesapp-core-in-the-root-vitest-config">
### `packages/app-core` dans la config Vitest racine
</div>

Le **`vitest.config.ts`** racine du repo (utilisé par **`bun run test`** → shard unitaire) inclut :

- **`packages/app-core/src/**/*.test.ts`** et **`packages/app-core/src/**/*.test.tsx`** — tests colocalisés, y compris TSX, sans lister chaque fichier.
- **`packages/app-core/test/**/*.test.ts`** et **`.../test/**/*.test.tsx`** — tests de harnais partagé (par ex. `test/state`, `test/runtime`).

**Pourquoi :** ces répertoires étaient précédemment omis, donc les nouvelles suites ne s'exécutaient jamais en CI. **`packages/app-core/test/**/*.e2e.test.ts(x)`** est exclu de ce job pour que les e2e restent sur **`test/vitest/e2e.config.ts`**. **`test/vitest/unit.config.ts`** omet toujours **`packages/app-core/test/app/**`** (harnais de renderer lourd) du passe unitaire axé couverture — **pourquoi :** ceux-ci sont exécutés dans des workspaces app ciblés ou des jobs séparés.

---

<div id="code-style">
## Style de code
</div>

<div id="typescript-guidelines">
### Directives TypeScript
</div>

- **Mode strict** — Toujours utiliser TypeScript strict
- **Éviter `any`** — Utiliser des types appropriés ou `unknown`
- **ESM** — Utiliser les modules ES (`import`/`export`)
- **Async/await** — Préféré aux promesses brutes

<div id="naming-conventions">
### Conventions de nommage
</div>

| Élément | Convention | Exemple |
|---------|------------|---------|
| Fichiers | kebab-case | `my-feature.ts` |
| Classes | PascalCase | `MyService` |
| Fonctions | camelCase | `processMessage` |
| Constantes | UPPER_SNAKE | `MAX_RETRIES` |
| Actions | UPPER_SNAKE | `RESTART_AGENT` |
| Types/Interfaces | PascalCase | `PluginConfig` |

<div id="product-vs-code-naming">
### Nommage produit vs code
</div>

- **Eliza** — Nom du produit, titres, documentation
- **eliza** — Commande CLI, nom de paquet, chemins, clés de config

<div id="formatting">
### Formatage
</div>

Le projet utilise **Biome** pour le formatage et le linting :

```bash
# Check formatting and lint
bun run check

# Fix formatting issues
bun run format:fix

# Fix lint issues
bun run lint:fix
```

<div id="file-size">
### Taille des fichiers
</div>

Visez à garder les fichiers sous **~500 lignes**. Divisez quand cela améliore :
- La clarté
- La testabilité
- La réutilisabilité

<div id="comments">
### Commentaires
</div>

```typescript
// ✅ Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;

// ❌ Don't explain obvious code
// Increment counter by 1
counter++;
```

<div id="error-handling">
### Gestion des erreurs
</div>

```typescript
// ✅ Specific error types with context
throw new Error(`Failed to load plugin "${name}": ${err.message}`);

// ✅ Graceful degradation
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn({ err, context }, "Operation failed, using fallback");
  return fallbackValue;
}

// ❌ Silent swallowing
try {
  await something();
} catch {}
```

---

<div id="pull-request-process">
## Processus de pull request
</div>

<div id="branch-strategy">
### Stratégie de branches
</div>

| Branche | Objectif | Publie vers |
|---------|----------|-------------|
| `develop` | Développement actif, les PRs fusionnent ici | Releases alpha |
| `main` | Releases stables | Releases beta |
| GitHub Releases | Versions taguées | Production (npm, PyPI, Snap, APT, Homebrew) |
| `feature/*` | Nouvelles fonctionnalités | — |
| `fix/*` | Corrections de bugs | — |

<div id="creating-a-pr">
### Créer un PR
</div>

1. **Fork et clone** (ou branche depuis develop)
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Faites des modifications** avec des commits significatifs
   ```bash
   git add .
   git commit -m "feat: add new action for X"
   ```

3. **Exécutez les vérifications avant le push**
   ```bash
   bun run check
   bun run test
   ```

4. **Push et créez le PR**
   ```bash
   git push origin feature/my-feature
   # Then open PR on GitHub
   ```

<div id="commit-message-format">
### Format des messages de commit
</div>

Utilisez les commits conventionnels :

```
<type>: <description>

[optional body]

[optional footer]
```

**Types :**
- `feat:` — Nouvelle fonctionnalité
- `fix:` — Correction de bug
- `docs:` — Documentation
- `refactor:` — Refactorisation du code
- `test:` — Ajouts/modifications de tests
- `chore:` — Build, deps, configs

**Exemples :**
```
feat: add voice message support to telegram connector

fix: prevent crash when config file is missing

docs: add plugin development guide

refactor: extract session key logic to provider

chore: update @elizaos/core to 2.0.0-alpha.4
```

<div id="pr-checklist">
### Checklist du PR
</div>

Avant de soumettre :

- [ ] Le code compile sans erreurs (`bun run build`)
- [ ] Les tests passent (`bun run test`)
- [ ] Le linting passe (`bun run check`)
- [ ] Le nouveau code a des tests (si applicable)
- [ ] La documentation est mise à jour (si applicable)
- [ ] Les messages de commit suivent les conventions
- [ ] La description du PR explique le changement

<div id="code-review">
### Revue de code
</div>

Les PRs sont revus par les mainteneurs. Attendez-vous à des retours sur :

- **Correction** — Est-ce que ça fonctionne ?
- **Conception** — L'approche est-elle solide ?
- **Style** — Suit-il les conventions ?
- **Tests** — Est-il adéquatement testé ?
- **Documentation** — Est-il documenté ?

Claude Code Review est activé pour le feedback initial automatisé.

---

<div id="community">
## Communauté
</div>

<div id="discord">
### Discord
</div>

Rejoignez le Discord de la communauté pour de l'aide, des discussions et des annonces :

**[discord.gg/ai16z](https://discord.gg/ai16z)**

Canaux :
- `#eliza` — Discussion spécifique à Eliza
- `#dev` — Aide au développement
- `#showcase` — Partagez ce que vous avez construit

<div id="github">
### GitHub
</div>

- **Issues** — Rapports de bugs, demandes de fonctionnalités
- **Discussions** — Questions, idées, RFC
- **PRs** — Contributions de code

<div id="reporting-issues">
### Signaler des problèmes
</div>

Lors du dépôt d'un issue :

1. **Vérifiez les issues existants** — Évitez les doublons
2. **Utilisez les templates** — Remplissez le template fourni
3. **Incluez la reproduction** — Étapes pour reproduire
4. **Partagez les logs** — Sortie d'erreur pertinente
5. **Environnement** — OS, version de Node, version de Eliza

```markdown
## Bug Report

**Describe the bug:**
Brief description

**To reproduce:**
1. Run `eliza start`
2. Send message "..."
3. Error occurs

**Expected behavior:**
What should happen

**Environment:**
- OS: macOS 14.2
- Node: 22.12.0
- Eliza: 2.0.0-alpha.8

**Logs:**
```
[error output here]
```
```

---

<div id="getting-help">
## Obtenir de l'aide
</div>

- **Discord** — Réponse la plus rapide pour les questions
- **GitHub Issues** — Rapports de bugs et fonctionnalités
- **Documentation** — Consultez `/docs` d'abord
- **AGENTS.md** — Directives spécifiques au repo

---

<div id="next-steps">
## Prochaines étapes
</div>

- [Guide de développement de plugins](/fr/plugins/development) — Créer des plugins
- [Documentation des skills](/fr/plugins/skills) — Créer des skills
- [Développement local de plugins](/fr/plugins/local-plugins) — Développer localement
- Parcourez le code : commencez par `src/runtime/eliza-plugin.ts`
