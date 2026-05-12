---
title: "Publier un Plugin"
sidebarTitle: "Publier"
description: "Comment empaqueter, versionner et publier un plugin Eliza sur le registre npm et le soumettre au registre communautaire."
---

Ce guide couvre le flux complet de publication d'un plugin Eliza — de l'empaquetage à la publication npm et la soumission au registre communautaire.

<div id="naming-conventions">

## Conventions de nommage

</div>

Choisissez un nom de package qui suit la convention établie :

| Portée | Modèle | Exemple |
|--------|--------|---------|
| elizaOS officiel | `@elizaos/plugin-{name}` | `@elizaos/plugin-openai` |
| Communauté (avec portée) | `@yourorg/plugin-{name}` | `@acme/plugin-analytics` |
| Communauté (sans portée) | `elizaos-plugin-{name}` | `elizaos-plugin-weather` |

Le runtime reconnaît les trois modèles pour la découverte automatique.

<div id="packagejson-requirements">

## Exigences du package.json

</div>

Le `package.json` de votre plugin doit inclure ces champs :

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "description": "One-line description of what this plugin does",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "elizaos.plugin.json"],
  "keywords": ["elizaos", "eliza", "plugin"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourorg/plugin-my-feature"
  },
  "peerDependencies": {
    "@elizaos/core": ">=2.0.0-alpha"
  },
  "devDependencies": {
    "@elizaos/core": "alpha",
    "typescript": "^5.0.0"
  }
}
```

**Points clés :**
- Déclarez `@elizaos/core` comme `peerDependency` — pas comme dépendance directe — pour éviter les conflits de version.
- Incluez `elizaos.plugin.json` dans `files` pour que le manifeste soit publié avec le code.
- Utilisez `"type": "module"` pour la sortie ESM.

<div id="build-configuration">

## Configuration de compilation

</div>

Utilisez TypeScript ciblant ESM :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

<div id="versioning">

## Versionnement

</div>

Suivez le [Versionnement Sémantique](https://semver.org/) :

| Changement | Incrément |
|------------|-----------|
| Nouvelle action, fournisseur ou fonctionnalité (rétrocompatible) | Minor (`1.0.0` → `1.1.0`) |
| Corrections de bugs uniquement | Patch (`1.0.0` → `1.0.1`) |
| Changement d'API incompatible | Major (`1.0.0` → `2.0.0`) |

Pour les plugins ciblant la ligne de publication `next` d'elizaOS, utilisez des versions de prépublication :

```bash
npm version prerelease --preid=next
# 1.0.0 → 1.0.1-next.0
```

<div id="publishing-to-npm">

## Publier sur npm

</div>

<div id="1-authenticate">

### 1. Authentification

</div>

```bash
npm login
```

<div id="2-build">

### 2. Compilation

</div>

```bash
bun run build
```

Vérifiez que le répertoire `dist/` contient la sortie compilée avant de publier.

<div id="3-dry-run">

### 3. Essai à blanc

</div>

Prévisualisez toujours ce qui sera publié :

```bash
npm publish --dry-run --access public
```

Vérifiez que la sortie inclut uniquement `dist/`, `elizaos.plugin.json`, `package.json` et `README.md`.

<div id="4-publish">

### 4. Publier

</div>

```bash
npm publish --access public
```

Pour les versions de prépublication ciblant la ligne de publication `next` d'elizaOS :

```bash
npm publish --access public --tag next
```

<div id="5-verify">

### 5. Vérifier

</div>

```bash
npm info @yourorg/plugin-my-feature
```

<div id="plugin-manifest">

## Manifeste du plugin

</div>

Incluez un `elizaos.plugin.json` à la racine du package pour une intégration enrichie avec l'interface du panneau d'administration Eliza :

```json
{
  "id": "my-feature",
  "name": "My Feature Plugin",
  "description": "Does something useful",
  "version": "1.0.0",
  "kind": "skill",

  "requiredSecrets": ["MY_FEATURE_API_KEY"],
  "optionalSecrets": ["MY_FEATURE_DEBUG"],

  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "endpoint": { "type": "string", "format": "uri" }
    },
    "required": ["apiKey"]
  },

  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true
    }
  }
}
```

<div id="best-practices">

## Bonnes pratiques

</div>

**Documentation :**
- Incluez un `README.md` avec les instructions d'installation, les variables d'environnement requises et des exemples d'utilisation.
- Documentez chaque action avec une description du moment où le LLM l'invoquera.
- Listez toutes les variables d'environnement requises et optionnelles dans un tableau.

**Sécurité :**
- Ne journalisez jamais les clés API ou les secrets — utilisez `runtime.logger` avec précaution.
- Validez et assainissez tous les paramètres dans les gestionnaires d'actions.
- Utilisez `peerDependencies` pour `@elizaos/core` afin d'éviter les installations en double.

**Compatibilité :**
- Testez avec la version `next` actuelle de `@elizaos/core`.
- Déclarez la plage de version de vos `peerDependencies` de manière conservatrice : `"@elizaos/core": ">=2.0.0"`.
- Exportez un export par défaut compatible avec le type `Plugin` — n'utilisez pas les exports par défaut à d'autres fins.

**Qualité :**
- Incluez des tests unitaires avec au moins 80% de couverture. (Note : c'est le seuil recommandé pour les plugins publiés indépendamment. Le monorepo applique un minimum de 25% de lignes/fonctions/instructions et 15% de branches depuis `scripts/coverage-policy.mjs`.)
- Exécutez `tsc --noEmit` dans la CI pour détecter les erreurs de types.
- Testez le package publié avec `npm pack` avant de publier.

<div id="multi-language-plugins">

## Plugins multi-langages

</div>

Les plugins peuvent inclure des implémentations dans plusieurs langages :

```
my-plugin/
├── typescript/     # Primary TypeScript implementation
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── python/         # Optional Python SDK bindings
│   ├── src/
│   └── pyproject.toml
├── rust/           # Optional Rust native module
│   ├── src/
│   └── Cargo.toml
└── elizaos.plugin.json
```

L'implémentation TypeScript est toujours obligatoire. Les implémentations Python et Rust sont optionnelles et utilisées par leurs SDKs respectifs. Le manifeste `elizaos.plugin.json` à la racine décrit le plugin pour tous les langages.

<div id="community-registry">

## Registre communautaire

</div>

Après avoir publié sur npm, soumettez votre plugin au registre communautaire en ouvrant une PR sur [`elizaos-plugins/registry`](https://github.com/elizaos-plugins/registry).

Incluez dans votre PR :
1. Une entrée dans `index.json` associant le nom de votre package à son dépôt git
2. Un manifeste `elizaos.plugin.json` fonctionnel dans votre package
3. Au moins une suite de tests réussie
4. Un README avec les instructions de configuration et les variables d'environnement requises

Les plugins communautaires sont examinés en termes de sécurité, fonctionnalité et qualité de documentation avant d'être répertoriés. Consultez la [Documentation du Registre](/fr/plugins/registry#submitting-a-plugin-to-the-registry) pour plus de détails.

<div id="related">

## Liens connexes

</div>

- [Schémas de Plugins](/fr/plugins/schemas) — Référence complète des schémas
- [Créer un Plugin](/fr/plugins/create-a-plugin) — Construire un plugin de zéro
- [Registre de Plugins](/fr/plugins/registry) — Parcourir les plugins publiés
