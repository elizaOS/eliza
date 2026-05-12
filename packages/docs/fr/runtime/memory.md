---
title: "Mémoire"
sidebarTitle: "Mémoire"
description: "Persistance de la mémoire, génération d'embeddings, recherche vectorielle, types de mémoire et l'API de récupération."
---

Le système de mémoire de Eliza est soutenu par `@elizaos/plugin-sql` pour la persistance et `@elizaos/plugin-local-embedding` pour les embeddings vectoriels. Cette page couvre l'infrastructure de mémoire du point de vue du runtime.

<div id="memory-architecture">

## Architecture de la Mémoire

</div>

```
User Message
    ↓
Memory Manager (via AgentRuntime)
    ↓
plugin-sql (PGLite / PostgreSQL)
    ↓
plugin-local-embedding (vector embeddings via node-llama-cpp)
    ↓
Memory retrieval → injected into context
```

<div id="database-backend">

## Backend de Base de Données

</div>

<div id="pglite-default">

### PGLite (par défaut)

</div>

PGLite est une compilation WebAssembly embarquée de PostgreSQL qui s'exécute dans le processus Node.js sans nécessiter de serveur de base de données externe. Eliza configure le répertoire de données via `PGLITE_DATA_DIR` :

```
Default: ~/.eliza/workspace/.eliza/.elizadb
```

Le répertoire est créé au démarrage s'il n'existe pas. Après `adapter.init()`, Eliza effectue une vérification de santé :

```typescript
const files = await fs.readdir(pgliteDataDir);
if (files.length === 0) {
  logger.warn("PGlite data directory is empty after init — data may not persist");
}
```

<div id="pglite-corruption-recovery">

### Récupération après Corruption de PGLite

</div>

Si l'initialisation de PGLite échoue avec une erreur récupérable (abandon WASM ou erreur de schéma de migrations), Eliza sauvegarde le répertoire de données existant et réessaie :

```typescript
// Back up: <dataDir>.corrupt-<timestamp>
// Then recreate the directory and retry init
```

Cela empêche les échecs de démarrage de persister un état PGLite corrompu.

<div id="postgresql">

### PostgreSQL

</div>

Pour les déploiements en production ou partagés, définissez `database.provider = "postgres"`. La chaîne de connexion est construite à partir des champs `database.postgres.*` et définie comme `POSTGRES_URL`.

<div id="embedding-model">

## Modèle d'Embedding

</div>

`@elizaos/plugin-local-embedding` est pré-enregistré avant `runtime.initialize()` pour s'assurer que son handler `TEXT_EMBEDDING` (priorité 10) l'emporte sur le handler de tout fournisseur cloud (priorité 0).

<div id="default-model">

### Modèle par Défaut

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
Dimensions: 768
Model directory: ~/.eliza/models/
```

<div id="environment-variables">

### Variables d'Environnement

</div>

Le plugin d'embedding lit la configuration à partir des variables d'environnement définies par `configureLocalEmbeddingPlugin()` :

| Variable | Par défaut | Description |
|---|---|---|
| `LOCAL_EMBEDDING_MODEL` | `nomic-embed-text-v1.5.Q5_K_M.gguf` | Nom de fichier du modèle GGUF |
| `LOCAL_EMBEDDING_MODEL_REPO` | auto | Dépôt Hugging Face pour le téléchargement |
| `LOCAL_EMBEDDING_DIMENSIONS` | auto | Dimensions du vecteur d'embedding |
| `LOCAL_EMBEDDING_CONTEXT_SIZE` | auto | Taille de la fenêtre de contexte |
| `LOCAL_EMBEDDING_GPU_LAYERS` | `"auto"` (Apple Silicon) / `"0"` (autres) | Accélération GPU |
| `LOCAL_EMBEDDING_USE_MMAP` | `"false"` (Apple Silicon) / `"true"` (autres) | Chargement du modèle en mémoire mappée |
| `MODELS_DIR` | `~/.eliza/models` | Répertoire de stockage des modèles |

<div id="memory-config">

## Configuration de la Mémoire

</div>

Le type `MemoryConfig` sélectionne le backend de mémoire :

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

<div id="built-in-backend">

### Backend Intégré

</div>

Le backend par défaut utilise la mémoire centrale d'elizaOS via `plugin-sql`. Il se configure dans `eliza.json` :

```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

<div id="qmd-backend">

### Backend QMD

</div>

Le backend Quantum Memory Daemon prend en charge l'indexation de chemins de fichiers externes :

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": true,
      "paths": [
        { "path": "~/notes", "name": "notes", "pattern": "**/*.md" },
        { "path": "~/projects/docs", "name": "project-docs" }
      ],
      "sessions": {
        "enabled": true,
        "exportDir": "~/.eliza/sessions",
        "retentionDays": 30
      },
      "update": {
        "interval": "30m",
        "onBoot": true,
        "debounceMs": 5000
      },
      "limits": {
        "maxResults": 20,
        "maxSnippetChars": 500,
        "maxInjectedChars": 4000,
        "timeoutMs": 3000
      }
    }
  }
}
```

<div id="vector-memory-search">

## Recherche Vectorielle de Mémoire

</div>

`MemorySearchConfig` contrôle la recherche par similarité vectorielle. Elle se définit globalement dans `agents.defaults.memorySearch` ou par agent dans `agents.list[n].memorySearch` :

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "sources": ["memory"],
        "provider": "local",
        "store": {
          "driver": "sqlite",
          "path": "~/.eliza/memory-search.db",
          "vector": {
            "enabled": true,
            "extensionPath": null
          },
          "cache": {
            "enabled": true,
            "maxEntries": 10000
          }
        },
        "chunking": {
          "tokens": 512,
          "overlap": 64
        },
        "query": {
          "maxResults": 10,
          "minScore": 0.7,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.6,
            "textWeight": 0.4,
            "candidateMultiplier": 4
          }
        },
        "sync": {
          "onSessionStart": true,
          "onSearch": false,
          "watch": false,
          "intervalMinutes": 60
        }
      }
    }
  }
}
```

<div id="search-sources">

### Sources de Recherche

</div>

| Source | Description |
|---|---|
| `"memory"` | Stockage de mémoire persistant de l'agent (par défaut) |
| `"sessions"` | Indexation des transcriptions de session (expérimental ; activer via `experimental.sessionMemory: true`) |

<div id="embedding-providers">

### Fournisseurs d'Embedding

</div>

| Valeur | Description |
|---|---|
| `"local"` | Modèle local node-llama-cpp (par défaut) |
| `"openai"` | API Embeddings d'OpenAI |
| `"gemini"` | API Embeddings de Google Gemini |

<div id="fallback-chain">

### Chaîne de Repli

</div>

Lorsque le fournisseur d'embedding principal échoue :

```json
{
  "memorySearch": {
    "fallback": "local"
  }
}
```

Valeurs acceptées : `"openai"`, `"gemini"`, `"local"`, `"none"`.

<div id="extra-knowledge-paths">

### Chemins de Connaissances Supplémentaires

</div>

Indexer des répertoires supplémentaires ou des fichiers Markdown en complément de la mémoire :

```json
{
  "memorySearch": {
    "extraPaths": [
      "~/notes/important",
      "~/projects/README.md"
    ]
  }
}
```

<div id="memory-pruning-and-compaction">

## Élagage et Compactage de la Mémoire

</div>

Lorsque le contexte approche des limites de tokens, Eliza peut élaguer les anciens résultats d'outils :

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "30m",
        "keepLastAssistants": 3,
        "softTrimRatio": 0.3,
        "hardClearRatio": 0.7,
        "minPrunableToolChars": 500,
        "tools": {
          "allow": ["web_search", "browser"],
          "deny": ["memory_search"]
        }
      }
    }
  }
}
```

Le compactage de contexte (résumé de l'historique plus ancien) est géré par l'auto-compactage central d'elizaOS dans le fournisseur de messages récents.

<div id="knowledge-plugin">

## Plugin de Connaissances

</div>

`knowledge` fournit la gestion de connaissances RAG. Il se charge au démarrage en tant que plugin central et s'intègre au stockage de mémoire pour récupérer des fragments de connaissances par similarité vectorielle à chaque tour pertinent.

<div id="related-pages">

## Pages Associées

</div>

- [Mémoire et État](/fr/agents/memory-and-state) — configuration de la mémoire au niveau de l'agent
- [Runtime Central](/fr/runtime/core) — ordre de pré-enregistrement et initialisation de la base de données
- [Modèles](/fr/runtime/models) — configuration du fournisseur de modèles pour les embeddings
