---
title: "内存"
sidebarTitle: "内存"
description: "内存持久化、嵌入生成、向量搜索、内存类型和检索 API。"
---

Eliza 的内存系统由 `@elizaos/plugin-sql` 提供持久化支持，由 `@elizaos/plugin-local-embedding` 提供向量嵌入支持。本页从运行时的角度介绍内存基础设施。

<div id="memory-architecture">

## 内存架构

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

## 数据库后端

</div>

<div id="pglite-default">

### PGLite（默认）

</div>

PGLite 是 PostgreSQL 的嵌入式 WebAssembly 构建版本，在 Node.js 进程中运行，无需外部数据库服务器。Eliza 通过 `PGLITE_DATA_DIR` 配置数据目录：

```
Default: ~/.eliza/workspace/.eliza/.elizadb
```

如果目录不存在，将在启动时创建。在 `adapter.init()` 之后，Eliza 会执行健康检查：

```typescript
const files = await fs.readdir(pgliteDataDir);
if (files.length === 0) {
  logger.warn("PGlite data directory is empty after init — data may not persist");
}
```

<div id="pglite-corruption-recovery">

### PGLite 损坏恢复

</div>

如果 PGLite 初始化因可恢复错误（WASM 中止或迁移架构错误）而失败，Eliza 会备份现有数据目录并重试：

```typescript
// Back up: <dataDir>.corrupt-<timestamp>
// Then recreate the directory and retry init
```

这可以防止启动失败导致 PGLite 损坏状态的持续存在。

<div id="postgresql">

### PostgreSQL

</div>

对于生产环境或共享部署，请设置 `database.provider = "postgres"`。连接字符串由 `database.postgres.*` 字段构建，并设置为 `POSTGRES_URL`。

<div id="embedding-model">

## 嵌入模型

</div>

`@elizaos/plugin-local-embedding` 在 `runtime.initialize()` 之前预注册，以确保其 `TEXT_EMBEDDING` 处理器（优先级 10）优先于任何云提供商的处理器（优先级 0）。

<div id="default-model">

### 默认模型

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
Dimensions: 768
Model directory: ~/.eliza/models/
```

<div id="environment-variables">

### 环境变量

</div>

嵌入插件从 `configureLocalEmbeddingPlugin()` 设置的环境变量中读取配置：

| 变量 | 默认值 | 描述 |
|---|---|---|
| `LOCAL_EMBEDDING_MODEL` | `nomic-embed-text-v1.5.Q5_K_M.gguf` | GGUF 模型文件名 |
| `LOCAL_EMBEDDING_MODEL_REPO` | auto | 用于下载的 Hugging Face 仓库 |
| `LOCAL_EMBEDDING_DIMENSIONS` | auto | 嵌入向量维度 |
| `LOCAL_EMBEDDING_CONTEXT_SIZE` | auto | 上下文窗口大小 |
| `LOCAL_EMBEDDING_GPU_LAYERS` | `"auto"`（Apple Silicon）/ `"0"`（其他） | GPU 加速 |
| `LOCAL_EMBEDDING_USE_MMAP` | `"false"`（Apple Silicon）/ `"true"`（其他） | 内存映射模型加载 |
| `MODELS_DIR` | `~/.eliza/models` | 模型存储目录 |

<div id="memory-config">

## 内存配置

</div>

`MemoryConfig` 类型用于选择内存后端：

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

<div id="built-in-backend">

### 内置后端

</div>

默认后端通过 `plugin-sql` 使用 elizaOS 核心内存。在 `eliza.json` 中进行配置：

```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

<div id="qmd-backend">

### QMD 后端

</div>

Quantum Memory Daemon 后端支持索引外部文件路径：

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

## 向量内存搜索

</div>

`MemorySearchConfig` 控制向量相似性搜索。可在 `agents.defaults.memorySearch` 全局设置，或在 `agents.list[n].memorySearch` 按代理设置：

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

### 搜索来源

</div>

| 来源 | 描述 |
|---|---|
| `"memory"` | 代理的持久化内存存储（默认） |
| `"sessions"` | 会话记录索引（实验性；通过 `experimental.sessionMemory: true` 启用） |

<div id="embedding-providers">

### 嵌入提供商

</div>

| 值 | 描述 |
|---|---|
| `"local"` | node-llama-cpp 本地模型（默认） |
| `"openai"` | OpenAI Embeddings API |
| `"gemini"` | Google Gemini Embeddings API |

<div id="fallback-chain">

### 回退链

</div>

当主要嵌入提供商失败时：

```json
{
  "memorySearch": {
    "fallback": "local"
  }
}
```

接受的值：`"openai"`、`"gemini"`、`"local"`、`"none"`。

<div id="extra-knowledge-paths">

### 额外知识路径

</div>

在内存之外索引额外的目录或 Markdown 文件：

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

## 内存修剪与压缩

</div>

当上下文接近 token 限制时，Eliza 可以修剪旧的工具结果：

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

上下文压缩（对较旧历史记录的摘要）由 elizaOS 核心在最近消息提供者中的自动压缩功能处理。

<div id="knowledge-plugin">

## 知识插件

</div>

`knowledge` 提供 RAG 知识管理。它在启动时作为核心插件加载，并与内存存储集成，在每个相关轮次中通过向量相似性检索知识片段。

<div id="related-pages">

## 相关页面

</div>

- [内存与状态](/zh/agents/memory-and-state) — 代理级别的内存配置
- [核心运行时](/zh/runtime/core) — 预注册顺序和数据库初始化
- [模型](/zh/runtime/models) — 嵌入的模型提供商配置
