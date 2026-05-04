---
title: "Memoria y Estado"
sidebarTitle: "Memoria y Estado"
description: "Tipos de memoria, composición de estado, configuración de búsqueda vectorial y configuración del modelo de embeddings para agentes Eliza."
---

Eliza utiliza el sistema de memoria de elizaOS respaldado por `@elizaos/plugin-sql` para la persistencia y `@elizaos/plugin-local-embedding` para embeddings vectoriales. La memoria se compone en el estado del agente en cada turno de conversación.

<div id="memory-backend">

## Backend de Memoria

</div>

El backend predeterminado es PGLite (PostgreSQL embebido). PostgreSQL puede configurarse para despliegues en producción.

<div id="pglite-default">

### PGLite (predeterminado)

</div>

PGLite almacena datos en un directorio local. Eliza fija el directorio de datos al inicio:

```
Default path: ~/.eliza/workspace/.eliza/.elizadb
```

Configurado mediante `eliza.json`:

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

Para despliegues compartidos o en producción:

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

Se puede usar un `connectionString` completo en lugar de campos individuales:

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

## Modelo de Embedding

</div>

`@elizaos/plugin-local-embedding` proporciona embeddings vectoriales usando un modelo GGUF local a través de `node-llama-cpp`. Se registra previamente antes de otros plugins para que su handler `TEXT_EMBEDDING` (prioridad 10) esté disponible antes de que los servicios se inicien.

<div id="default-model">

### Modelo Predeterminado

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
```

Los modelos se almacenan en `~/.eliza/models/` de forma predeterminada.

<div id="embedding-configuration">

### Configuración de Embedding

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

| Campo | Tipo | Predeterminado | Descripción |
|---|---|---|---|
| `model` | string | `nomic-embed-text-v1.5.Q5_K_M.gguf` | Nombre de archivo del modelo GGUF |
| `modelRepo` | string | auto | Repositorio de Hugging Face para la descarga del modelo |
| `dimensions` | number | 768 | Dimensiones del vector de embedding |
| `contextSize` | number | sugerencia del modelo | Ventana de contexto para el modelo de embedding |
| `gpuLayers` | number \| "auto" \| "max" | `"auto"` en Apple Silicon, `0` en otros | Capas de aceleración GPU |
| `idleTimeoutMinutes` | number | 30 | Minutos antes de descargar el modelo de la memoria; 0 = nunca |

En Apple Silicon, `mmap` está deshabilitado de forma predeterminada para prevenir errores de carga del modelo en Metal.

<div id="memory-search-vector-search">

## Búsqueda de Memoria (Búsqueda Vectorial)

</div>

Eliza incluye un sistema configurable de búsqueda de memoria vectorial. La configuración se encuentra bajo `agents.defaults.memorySearch` o por agente en `agents.list[n].memorySearch`:

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

### Fuentes de Búsqueda

</div>

| Fuente | Descripción |
|---|---|
| `"memory"` | Almacén de memoria persistente del agente (predeterminado) |
| `"sessions"` | Transcripciones de sesiones anteriores (experimental) |

<div id="hybrid-search">

### Búsqueda Híbrida

</div>

Cuando `hybrid.enabled` es true, los resultados de búsqueda combinan la relevancia de texto BM25 con la similitud vectorial:

- `vectorWeight` — peso para la similitud coseno (predeterminado 0.6)
- `textWeight` — peso para la coincidencia de texto BM25 (predeterminado 0.4)
- `candidateMultiplier` — tamaño del grupo de candidatos antes del re-ranking (predeterminado 4)

<div id="embedding-providers-for-search">

### Proveedores de Embedding para Búsqueda

</div>

| Proveedor | Descripción |
|---|---|
| `"local"` | Usa modelo GGUF local a través de node-llama-cpp |
| `"openai"` | API de embeddings de OpenAI |
| `"gemini"` | API de embeddings de Google Gemini |

<div id="memory-config-type">

## Tipo MemoryConfig

</div>

El tipo `MemoryConfig` controla la selección del backend de memoria:

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

El backend `qmd` (Quantum Memory Daemon) es un almacén de memoria alternativo que soporta rutas de conocimiento indexado externo:

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

## Compactación

</div>

Cuando el contexto de la conversación se acerca a los límites de tokens, el sistema de compactación resume el contexto más antiguo. Configuración bajo `agents.defaults.compaction`:

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

| Modo | Comportamiento |
|---|---|
| `"default"` | Compactación estándar mediante auto-compactación del núcleo de elizaOS |
| `"safeguard"` | Poda más agresiva, limita el historial a `maxHistoryShare` de la ventana de contexto |

<div id="context-pruning">

## Poda de Contexto

</div>

Distinta de la compactación, la poda de contexto elimina resultados antiguos de herramientas para reducir el uso de tokens durante conversaciones activas:

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

## Integración de Conocimiento

</div>

`knowledge` proporciona gestión de conocimiento RAG (Generación Aumentada por Recuperación). Se carga como un plugin principal y se integra con el sistema de memoria para inyectar fragmentos de conocimiento relevantes en el contexto del agente basándose en la similitud vectorial.

<div id="related-pages">

## Páginas Relacionadas

</div>

- [Referencia de Memoria del Runtime](/es/runtime/memory) — Interfaz MemoryManager y API de recuperación
- [Interfaz de Personaje](./character-interface) — cómo se ensambla el Character
- [Runtime y Ciclo de Vida](./runtime-and-lifecycle) — cuándo se inicializa la memoria
