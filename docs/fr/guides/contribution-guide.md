---
title: "Guide de contribution"
sidebarTitle: "Contribution"
description: "Configurez votre environnement de développement et contribuez à Milady."
---

Bienvenue dans le projet Milady. Ce guide couvre la configuration de l'environnement, le workflow de développement et le processus de pull request.

Avant de contribuer, lisez [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) à la racine du repo pour connaître la philosophie de contribution du projet. Milady est un **codebase agents-only** -- chaque PR est revu et mergé par des agents IA, pas par des mainteneurs humains. Les humains contribuent principalement en tant que testeurs QA et rapporteurs de bugs.

---

<div id="prerequisites">
## Prérequis
</div>

| Outil | Version | Objectif |
|-------|---------|----------|
| [Node.js](https://nodejs.org/) | >= 22 | Runtime (requis par le champ `engines`) |
| [Bun](https://bun.sh/) | Dernière | Gestionnaire de paquets et exécuteur de scripts |
| [Git](https://git-scm.com/) | Dernière | Contrôle de version |

Bun est le gestionnaire de paquets du projet. Toutes les commandes de ce guide utilisent `bun`.

---

<div id="setup">
## Installation
</div>

```bash
# Clone the repository
git clone https://github.com/milady-ai/milady.git
cd milady

# Install dependencies
bun install

# Build the project (TypeScript via tsdown + UI build)
bun run build
```

Après le build, vérifiez que le CLI fonctionne :

```bash
bun run milady --help
```

La configuration est stockée dans `~/.milady/milady.json` et le workspace réside dans `~/.milady/workspace/`.

---

<div id="development-workflow">
## Workflow de développement
</div>

<div id="running-in-development">
### Exécution en développement
</div>

```bash
# Start dev server with auto-reload
bun run dev

# Run UI development only
bun run dev:ui

# Desktop app (Electrobun) development
bun run dev:desktop

# Run the CLI directly
bun run milady start
```

<div id="testing">
### Tests
</div>

Le projet utilise **Vitest 4.x** avec couverture V8. Les seuils de couverture sont définis dans `scripts/coverage-policy.mjs` à **25%** pour les lignes, fonctions et déclarations, et **15%** pour les branches.

```bash
# Run all tests (parallel runner)
bun run test

# Watch mode
bun run test:watch

# Run with coverage report
bun run test:coverage

# Run database safety/migration compatibility checks
bun run db:check

# End-to-end tests
bun run test:e2e

# Live API tests (requires API keys)
MILADY_LIVE_TEST=1 bun run test:live

# Docker-based integration tests
bun run test:docker:all
```

**Conventions des fichiers de test :**

| Pattern | Emplacement | Objectif |
|---------|-------------|----------|
| `*.test.ts` | Colocalisé avec le source | Tests unitaires |
| `*.e2e.test.ts` | Répertoire `test/` | Tests end-to-end |
| `*.live.test.ts` | Répertoire `test/` | Tests d'API en direct (nécessitent de vraies clés) |

<div id="linting-and-formatting">
### Linting et formatage
</div>

Le projet utilise **Biome 2.x** pour le linting et le formatage. Il n'y a pas d'ESLint ni de Prettier -- Biome gère tout.

```bash
# Run typecheck + lint (the main pre-push check)
bun run check

# Auto-fix formatting issues
bun run format:fix

# Auto-fix lint issues
bun run lint:fix
```

Règles Biome clés configurées dans `biome.json` :

- `noExplicitAny` : **error** -- éviter les types `any`
- `noNonNullAssertion` : warn
- `noImplicitAnyLet` : warn
- Formateur : indentation 2 espaces, espaces (pas de tabs)
- Organisation des imports activée

<div id="build-commands">
### Commandes de build
</div>

```bash
# Full build (TypeScript + UI)
bun run build

# Build using Node.js (instead of Bun runtime)
bun run build

# Desktop app (Electrobun)
bun run build:desktop

# Mobile builds
bun run build:android
bun run build:ios
```

---

<div id="pull-request-process">
## Processus de pull request
</div>

<div id="branch-strategy">
### Stratégie de branches
</div>

| Branche | Objectif |
|---------|----------|
| `main` | Releases stables (publiées sur npm) |
| `develop` | Branche d'intégration (cible PR par défaut) |
| `feature/*` | Nouvelles fonctionnalités |
| `fix/*` | Corrections de bugs |

Toujours brancher depuis `develop` et cibler les PRs vers `develop`.

<div id="step-by-step">
### Étape par étape
</div>

1. **Créez une branche depuis develop**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-feature
   ```

2. **Faites des modifications** avec des commits concis et orientés action
   ```bash
   git commit -m "milady: add verbose flag to send action"
   ```

3. **Exécutez les vérifications avant le push**
   ```bash
   bun run check
   bun run test
   bun run build
   ```

4. **Push et ouvrez un PR**
   ```bash
   git push origin feature/my-feature
   ```
   Ouvrez le PR contre `develop` sur GitHub.

<div id="commit-conventions">
### Conventions de commit
</div>

Le projet utilise des messages de commit concis et orientés action. Les préfixes de commit conventionnels sont courants :

```
feat: add voice message support to telegram connector
fix: prevent crash when config file is missing
test: add regression test for session timeout
refactor: extract session key logic to provider
chore: update @elizaos/core to latest
```

D'autres styles acceptés suivent le pattern `milady: description` vu dans l'historique du repo (par ex. `milady: fix telegram reconnect on rate limit`).

<div id="the-agent-review-bot">
### Le bot de revue par agents
</div>

Chaque PR déclenche le workflow GitHub Actions **Agent Review**. Voici comment il fonctionne :

1. **Classification** -- Le workflow classifie automatiquement votre PR comme `bugfix`, `feature` ou `aesthetic` basé sur le titre et le corps.

2. **Claude Code Review** -- Un agent IA (Claude Opus) effectue une revue de code complète. Il évalue :
   - **Portée** -- Le changement est-il dans le périmètre du projet ?
   - **Qualité du code** -- Mode strict TypeScript, conformité Biome, taille des fichiers
   - **Sécurité** -- Injection de prompt, exposition de credentials, risques supply chain
   - **Tests** -- Les bugfixes doivent inclure des tests de régression ; les features doivent inclure des tests unitaires

3. **Décision** -- L'agent émet l'un des trois verdicts :
   - **APPROVE** -- Le PR passe la revue et est auto-mergé (squash merge) dans `develop`
   - **REQUEST CHANGES** -- Problèmes trouvés ; corrigez et poussez à nouveau pour relancer la revue
   - **CLOSE** -- Le PR est hors périmètre et sera fermé automatiquement

4. **Score de confiance** -- Les contributeurs construisent un score de confiance au fil du temps. Une confiance plus élevée signifie des revues accélérées ; les nouveaux contributeurs reçoivent un examen plus approfondi.

**Il n'y a pas de chemin d'escalade humain**. La décision de l'agent est finale. Si vous n'êtes pas d'accord, améliorez le PR et ressoumettez.

**Ce qui est rejeté immédiatement :**
- Redesigns esthétiques/UI, changements de thèmes, échanges d'icônes, changements de polices
- PRs de "beautification" qui n'améliorent pas la capacité de l'agent
- Code non testé pour des changements testables
- Extension de portée déguisée en améliorations

<div id="pr-checklist">
### Checklist du PR
</div>

Avant de soumettre, vérifiez :

- [ ] `bun run build` se termine sans erreurs
- [ ] `bun run test` passe
- [ ] `bun run check` passe (typecheck + lint)
- [ ] Les bugfixes incluent un test de régression
- [ ] Les nouvelles features incluent des tests unitaires
- [ ] Pas de secrets, credentials réels ou valeurs de config live dans le code
- [ ] Les messages de commit sont concis et descriptifs
- [ ] La description du PR résume le changement et note les tests effectués

---

<div id="code-style">
## Style de code
</div>

<div id="typescript">
### TypeScript
</div>

- **Mode strict** -- Toujours utiliser TypeScript strict
- **Pas de `any`** -- Biome applique `noExplicitAny` comme erreur. Utilisez des types appropriés ou `unknown`.
- **ESM** -- Utilisez la syntaxe de modules ES (`import`/`export`)
- **Async/await** -- Préféré aux chaînes de promesses brutes

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

- **Milady** -- Nom du produit, titres, prose de documentation
- **milady** -- Nom du binaire CLI, chemins de paquets, clés de config

<div id="file-size">
### Taille des fichiers
</div>

Gardez les fichiers sous **~500 lignes**. Divisez quand cela améliore la clarté, la testabilité ou la réutilisabilité.

<div id="comments">
### Commentaires
</div>

```typescript
// Explain WHY, not WHAT
// Rate limit to avoid API throttling during batch operations
const BATCH_DELAY_MS = 100;
```

<div id="error-handling">
### Gestion des erreurs
</div>

```typescript
// Specific error messages with context
throw new Error("Failed to load plugin: " + err.message);

// Graceful degradation over silent swallowing
try {
  await riskyOperation();
} catch (err) {
  runtime.logger?.warn(err, "Operation failed, using fallback");
  return fallbackValue;
}
```

<div id="editor-setup">
### Configuration de l'éditeur
</div>

Paramètres VS Code recommandés :

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome"
}
```

Installez l'[extension Biome pour VS Code](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) pour le formatage et le feedback de lint dans l'éditeur.

---

<div id="project-structure">
## Structure du projet
</div>

```
milady/
├── apps/
│   ├── app/                 # Desktop/mobile app (Capacitor + React)
│   │   ├── electrobun/      # Electrobun desktop wrapper
│   │   └── src/             # React UI components
├── deploy/                  # Docker deployment configs
├── docs/                    # Documentation site
├── packages/                # Workspace packages
├── plugins/                 # Workspace plugin packages
├── scripts/                 # Build, dev, and release tooling
├── skills/                  # Skill catalog cache
├── src/                     # Core source code
│   ├── actions/             # Agent actions
│   ├── api/                 # HTTP API routes
│   ├── cli/                 # CLI command definitions
│   ├── config/              # Configuration handling
│   ├── hooks/               # Runtime hooks
│   ├── plugins/             # Built-in plugins
│   ├── providers/           # Context providers
│   ├── runtime/             # elizaOS runtime wrapper
│   ├── security/            # Security utilities
│   ├── services/            # Background services
│   ├── triggers/            # Trigger system
│   ├── tui/                 # Terminal UI (disabled)
│   └── utils/               # Helper utilities
├── test/                    # Test setup, helpers, e2e scripts
├── AGENTS.md                # Repository guidelines for agents
├── CONTRIBUTING.md          # Contribution philosophy
├── package.json             # Root package config
├── plugins.json             # Plugin registry manifest
├── biome.json               # Biome linter/formatter config
├── tsconfig.json            # TypeScript config
├── tsdown.config.ts         # Build config (tsdown bundler)
├── vitest.config.ts         # Vitest test config
└── milady.mjs               # npm bin entry point
```

<div id="key-entry-points">
### Points d'entrée clés
</div>

| Fichier | Objectif |
|---------|----------|
| `src/entry.ts` | Point d'entrée CLI |
| `src/index.ts` | Exports de librairie |
| `src/runtime/eliza.ts` | Initialisation du runtime elizaOS |
| `src/runtime/milady-plugin.ts` | Plugin principal Milady |
| `milady.mjs` | Entrée bin npm (`"bin"` dans package.json) |

---

<div id="reporting-issues">
## Signaler des problèmes
</div>

Lors du dépôt d'un rapport de bug :

1. **Vérifiez les issues existants** pour éviter les doublons
2. **Incluez des étapes de reproduction** -- ce que vous avez fait, ce qui s'est passé, ce que vous attendiez
3. **Partagez votre environnement** -- OS, version de Node, version de Milady (`milady --version`)
4. **Joignez les logs** -- sortie d'erreur pertinente

Un agent IA trie tous les issues entrants. Les bugs valides sont étiquetés et priorisés. Les issues hors périmètre (requêtes esthétiques, extension de fonctionnalités) seront fermés avec une explication.

---

<div id="further-reading">
## Lecture complémentaire
</div>

- [CONTRIBUTING.md](https://github.com/milady-ai/milady/blob/develop/CONTRIBUTING.md) -- Philosophie complète de contribution
- [AGENTS.md](https://github.com/milady-ai/milady/blob/develop/AGENTS.md) -- Directives du repo pour les agents de codage
- [Guide de développement de plugins](/fr/plugins/development) -- Créer des plugins
- [Documentation des skills](/fr/plugins/skills) -- Créer des skills
- [Développement local de plugins](/fr/plugins/local-plugins) -- Développer des plugins localement
