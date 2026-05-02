---
title: "Memoria"
sidebarTitle: "Memoria"
description: "Persistencia de memoria, generación de embeddings, búsqueda vectorial, tipos de memoria y la API de recuperación."
---

El sistema de memoria de Eliza está respaldado por `@elizaos/plugin-sql` para la persistencia y `@elizaos/plugin-local-embedding` para los embeddings vectoriales. Esta página cubre la infraestructura de memoria desde la perspectiva del runtime.

<div id="memory-architecture">

## Arquitectura de Memoria

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

## Backend de Base de Datos

</div>

<div id="pglite-default">

### PGLite (por defecto)

</div>

PGLite es una compilación WebAssembly embebida de PostgreSQL que se ejecuta en el proceso de Node.js sin necesidad de un servidor de base de datos externo. Eliza configura el directorio de datos mediante `PGLITE_DATA_DIR`:

```
Default: ~/.eliza/workspace/.eliza/.elizadb
```

El directorio se crea al iniciar si no existe. Después de `adapter.init()`, Eliza realiza una verificación de salud:

```typescript
const files = await fs.readdir(pgliteDataDir);
if (files.length === 0) {
  logger.warn("PGlite data directory is empty after init — data may not persist");
}
```

<div id="pglite-corruption-recovery">

### Recuperación de Corrupción de PGLite

</div>

Si la inicialización de PGLite falla con un error recuperable (aborto de WASM o error de esquema de migraciones), Eliza realiza una copia de seguridad del directorio de datos existente y reintenta:

```typescript
// Back up: <dataDir>.corrupt-<timestamp>
// Then recreate the directory and retry init
```

Esto evita que fallos de inicio persistan un estado corrupto de PGLite.

<div id="postgresql">

### PostgreSQL

</div>

Para despliegues en producción o compartidos, establezca `database.provider = "postgres"`. La cadena de conexión se construye a partir de los campos `database.postgres.*` y se establece como `POSTGRES_URL`.

<div id="embedding-model">

## Modelo de Embedding

</div>

`@elizaos/plugin-local-embedding` se registra previamente antes de `runtime.initialize()` para asegurar que su handler `TEXT_EMBEDDING` (prioridad 10) tenga precedencia sobre el handler de cualquier proveedor en la nube (prioridad 0).

<div id="default-model">

### Modelo por Defecto

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
Dimensions: 768
Model directory: ~/.eliza/models/
```

<div id="environment-variables">

### Variables de Entorno

</div>

El plugin de embedding lee la configuración de variables de entorno establecidas por `configureLocalEmbeddingPlugin()`:

| Variable | Por defecto | Descripción |
|---|---|---|
| `LOCAL_EMBEDDING_MODEL` | `nomic-embed-text-v1.5.Q5_K_M.gguf` | Nombre de archivo del modelo GGUF |
| `LOCAL_EMBEDDING_MODEL_REPO` | auto | Repositorio de Hugging Face para descarga |
| `LOCAL_EMBEDDING_DIMENSIONS` | auto | Dimensiones del vector de embedding |
| `LOCAL_EMBEDDING_CONTEXT_SIZE` | auto | Tamaño de la ventana de contexto |
| `LOCAL_EMBEDDING_GPU_LAYERS` | `"auto"` (Apple Silicon) / `"0"` (otros) | Aceleración por GPU |
| `LOCAL_EMBEDDING_USE_MMAP` | `"false"` (Apple Silicon) / `"true"` (otros) | Carga del modelo mapeada en memoria |
| `MODELS_DIR` | `~/.eliza/models` | Directorio para almacenamiento de modelos |

<div id="memory-config">

## Configuración de Memoria

</div>

El tipo `MemoryConfig` selecciona el backend de memoria:

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

<div id="built-in-backend">

### Backend Integrado

</div>

El backend por defecto utiliza la memoria central de elizaOS mediante `plugin-sql`. Se configura en `eliza.json`:

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

El backend Quantum Memory Daemon soporta la indexación de rutas de archivos externos:

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

## Búsqueda Vectorial de Memoria

</div>

`MemorySearchConfig` controla la búsqueda por similitud vectorial. Se establece globalmente en `agents.defaults.memorySearch` o por agente en `agents.list[n].memorySearch`:

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

### Fuentes de Búsqueda

</div>

| Fuente | Descripción |
|---|---|
| `"memory"` | Almacén de memoria persistente del agente (por defecto) |
| `"sessions"` | Indexación de transcripciones de sesión (experimental; habilitar mediante `experimental.sessionMemory: true`) |

<div id="embedding-providers">

### Proveedores de Embedding

</div>

| Valor | Descripción |
|---|---|
| `"local"` | Modelo local node-llama-cpp (por defecto) |
| `"openai"` | API de Embeddings de OpenAI |
| `"gemini"` | API de Embeddings de Google Gemini |

<div id="fallback-chain">

### Cadena de Respaldo

</div>

Cuando el proveedor de embedding principal falla:

```json
{
  "memorySearch": {
    "fallback": "local"
  }
}
```

Valores aceptados: `"openai"`, `"gemini"`, `"local"`, `"none"`.

<div id="extra-knowledge-paths">

### Rutas de Conocimiento Adicionales

</div>

Indexar directorios adicionales o archivos Markdown junto con la memoria:

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

## Poda y Compactación de Memoria

</div>

Cuando el contexto se acerca a los límites de tokens, Eliza puede podar resultados antiguos de herramientas:

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

La compactación de contexto (resumen del historial más antiguo) es gestionada por la auto-compactación central de elizaOS en el proveedor de mensajes recientes.

<div id="knowledge-plugin">

## Plugin de Conocimiento

</div>

`knowledge` proporciona gestión de conocimiento RAG. Se carga al inicio como un plugin central y se integra con el almacén de memoria para recuperar fragmentos de conocimiento por similitud vectorial en cada turno relevante.

<div id="related-pages">

## Páginas Relacionadas

</div>

- [Memoria y Estado](/es/agents/memory-and-state) — configuración de memoria a nivel de agente
- [Runtime Central](/es/runtime/core) — orden de pre-registro e inicialización de base de datos
- [Modelos](/es/runtime/models) — configuración del proveedor de modelos para embeddings
