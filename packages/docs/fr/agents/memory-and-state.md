---
title: "Mémoire et État"
sidebarTitle: "Mémoire et État"
description: "Types de mémoire, composition de l'état, configuration de la recherche vectorielle et configuration du modèle d'embedding pour les agents Eliza."
---

Eliza utilise le système de mémoire d'elizaOS soutenu par `@elizaos/plugin-sql` pour la persistance et `@elizaos/plugin-local-embedding` pour les embeddings vectoriels. La mémoire est composée dans l'état de l'agent à chaque tour de conversation.

<div id="memory-backend">

## Backend de Mémoire

</div>

Le backend par défaut est PGLite (PostgreSQL embarqué). PostgreSQL peut être configuré pour les déploiements en production.

<div id="pglite-default">

### PGLite (par défaut)

</div>

PGLite stocke les données dans un répertoire local. Eliza fixe le répertoire de données au démarrage :

```
Default path: ~/.eliza/workspace/.eliza/.elizadb
```

Configuré via `eliza.json` :

```json
{
  "database": {
    "provider": "pglite",
    "pglite": {
      "dataDir": "~/.eliza/workspace/.eliza/.elizadb"
    }
  }
}
```

<div id="postgresql">

### PostgreSQL

</div>

Pour les déploiements partagés ou en production :

```json
{
  "database": {
    "provider": "postgres",
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "eliza",
      "user": "postgres",
      "password": "secret",
      "ssl": false
    }
  }
}
```

Un `connectionString` complet peut être utilisé à la place des champs individuels :

```json
{
  "database": {
    "provider": "postgres",
    "postgres": {
      "connectionString": "postgresql://postgres:secret@localhost:5432/eliza"
    }
  }
}
```

<div id="embedding-model">

## Modèle d'Embedding

</div>

`@elizaos/plugin-local-embedding` fournit des embeddings vectoriels en utilisant un modèle GGUF local via `node-llama-cpp`. Il est pré-enregistré avant les autres plugins afin que son handler `TEXT_EMBEDDING` (priorité 10) soit disponible avant le démarrage des services.

<div id="default-model">

### Modèle par Défaut

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
```

Les modèles sont stockés dans `~/.eliza/models/` par défaut.

<div id="embedding-configuration">

### Configuration de l'Embedding

</div>

```json
{
  "embedding": {
    "model": "nomic-embed-text-v1.5.Q5_K_M.gguf",
    "modelRepo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
    "dimensions": 768,
    "contextSize": 2048,
    "gpuLayers": "auto",
    "idleTimeoutMinutes": 30
  }
}
```

| Champ | Type | Par défaut | Description |
|---|---|---|---|
| `model` | string | `nomic-embed-text-v1.5.Q5_K_M.gguf` | Nom de fichier du modèle GGUF |
| `modelRepo` | string | auto | Dépôt Hugging Face pour le téléchargement du modèle |
| `dimensions` | number | 768 | Dimensions du vecteur d'embedding |
| `contextSize` | number | indication du modèle | Fenêtre de contexte pour le modèle d'embedding |
| `gpuLayers` | number \| "auto" \| "max" | `"auto"` sur Apple Silicon, `0` ailleurs | Couches d'accélération GPU |
| `idleTimeoutMinutes` | number | 30 | Minutes avant le déchargement du modèle de la mémoire ; 0 = jamais |

Sur Apple Silicon, `mmap` est désactivé par défaut pour éviter les erreurs de chargement du modèle sur Metal.

<div id="memory-search-vector-search">

## Recherche en Mémoire (Recherche Vectorielle)

</div>

Eliza inclut un système configurable de recherche en mémoire vectorielle. La configuration se trouve sous `agents.defaults.memorySearch` ou par agent dans `agents.list[n].memorySearch` :

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
          "vector": { "enabled": true }
        },
        "query": {
          "maxResults": 10,
          "minScore": 0.7,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.6,
            "textWeight": 0.4
          }
        },
        "chunking": {
          "tokens": 512,
          "overlap": 64
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
| `"memory"` | Magasin de mémoire persistante de l'agent (par défaut) |
| `"sessions"` | Transcriptions de sessions passées (expérimental) |

<div id="hybrid-search">

### Recherche Hybride

</div>

Lorsque `hybrid.enabled` est true, les résultats de recherche fusionnent la pertinence textuelle BM25 avec la similarité vectorielle :

- `vectorWeight` — poids pour la similarité cosinus (par défaut 0.6)
- `textWeight` — poids pour la correspondance textuelle BM25 (par défaut 0.4)
- `candidateMultiplier` — taille du pool de candidats avant le re-classement (par défaut 4)

<div id="embedding-providers-for-search">

### Fournisseurs d'Embedding pour la Recherche

</div>

| Fournisseur | Description |
|---|---|
| `"local"` | Utilise un modèle GGUF local via node-llama-cpp |
| `"openai"` | API d'embeddings OpenAI |
| `"gemini"` | API d'embeddings Google Gemini |

<div id="memory-config-type">

## Type MemoryConfig

</div>

Le type `MemoryConfig` contrôle la sélection du backend de mémoire :

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

Le backend `qmd` (Quantum Memory Daemon) est un magasin de mémoire alternatif prenant en charge les chemins de connaissances indexées externes :

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "paths": [
        { "path": "~/notes", "name": "personal-notes", "pattern": "**/*.md" }
      ],
      "sessions": {
        "enabled": true,
        "retentionDays": 30
      },
      "limits": {
        "maxResults": 20,
        "maxSnippetChars": 500,
        "maxInjectedChars": 4000
      }
    }
  }
}
```

<div id="compaction">

## Compaction

</div>

Lorsque le contexte de la conversation approche les limites de tokens, le système de compaction résume le contexte plus ancien. Configuration sous `agents.defaults.compaction` :

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "default",
        "reserveTokensFloor": 1000,
        "maxHistoryShare": 0.5,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 2000
        }
      }
    }
  }
}
```

| Mode | Comportement |
|---|---|
| `"default"` | Compaction standard via l'auto-compaction du noyau elizaOS |
| `"safeguard"` | Élagage plus agressif, limite l'historique à `maxHistoryShare` de la fenêtre de contexte |

<div id="context-pruning">

## Élagage du Contexte

</div>

Distinct de la compaction, l'élagage du contexte supprime les anciens résultats d'outils pour réduire l'utilisation de tokens durant les conversations actives :

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "30m",
        "keepLastAssistants": 3,
        "softTrimRatio": 0.3,
        "hardClearRatio": 0.7
      }
    }
  }
}
```

<div id="knowledge-integration">

## Intégration des Connaissances

</div>

`knowledge` fournit la gestion des connaissances RAG (Génération Augmentée par Récupération). Il est chargé en tant que plugin principal et s'intègre au système de mémoire pour injecter des fragments de connaissances pertinents dans le contexte de l'agent en fonction de la similarité vectorielle.

<div id="related-pages">

## Pages Associées

</div>

- [Référence de la Mémoire du Runtime](/fr/runtime/memory) — Interface MemoryManager et API de récupération
- [Interface de Personnage](./character-interface) — comment le Character est assemblé
- [Runtime et Cycle de Vie](./runtime-and-lifecycle) — quand la mémoire est initialisée
