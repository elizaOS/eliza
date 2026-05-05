---
title: "内存与状态"
sidebarTitle: "内存与状态"
description: "Eliza 代理的内存类型、状态组合、向量搜索配置和嵌入模型设置。"
---

Eliza 使用 elizaOS 内存系统，以 `@elizaos/plugin-sql` 实现持久化，以 `@elizaos/plugin-local-embedding` 实现向量嵌入。内存在每个对话轮次中被组合到代理状态中。

<div id="memory-backend">

## 内存后端

</div>

默认后端是 PGLite（嵌入式 PostgreSQL）。PostgreSQL 可以为生产部署进行配置。

<div id="pglite-default">

### PGLite（默认）

</div>

PGLite 将数据存储在本地目录中。Eliza 在启动时固定数据目录：

```
Default path: ~/.eliza/workspace/.eliza/.elizadb
```

通过 `eliza.json` 配置：

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

用于共享或生产部署：

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

可以使用完整的 `connectionString` 代替单独的字段：

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

## 嵌入模型

</div>

`@elizaos/plugin-local-embedding` 通过 `node-llama-cpp` 使用本地 GGUF 模型提供向量嵌入。它在其他插件之前预注册，以便其 `TEXT_EMBEDDING` 处理程序（优先级 10）在服务启动之前可用。

<div id="default-model">

### 默认模型

</div>

```
nomic-embed-text-v1.5.Q5_K_M.gguf
```

模型默认存储在 `~/.eliza/models/` 中。

<div id="embedding-configuration">

### 嵌入配置

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

| 字段 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `model` | string | `nomic-embed-text-v1.5.Q5_K_M.gguf` | GGUF 模型文件名 |
| `modelRepo` | string | auto | 用于模型下载的 Hugging Face 仓库 |
| `dimensions` | number | 768 | 嵌入向量维度 |
| `contextSize` | number | 模型提示值 | 嵌入模型的上下文窗口 |
| `gpuLayers` | number \| "auto" \| "max" | Apple Silicon 上为 `"auto"`，其他为 `0` | GPU 加速层数 |
| `idleTimeoutMinutes` | number | 30 | 从内存中卸载模型前的分钟数；0 = 永不卸载 |

在 Apple Silicon 上，`mmap` 默认禁用以防止 Metal 上的模型加载错误。

<div id="memory-search-vector-search">

## 内存搜索（向量搜索）

</div>

Eliza 包含一个可配置的向量内存搜索系统。配置位于 `agents.defaults.memorySearch` 下或在 `agents.list[n].memorySearch` 中按代理配置：

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

### 搜索来源

</div>

| 来源 | 描述 |
|---|---|
| `"memory"` | 代理的持久内存存储（默认） |
| `"sessions"` | 过去的会话记录（实验性） |

<div id="hybrid-search">

### 混合搜索

</div>

当 `hybrid.enabled` 为 true 时，搜索结果会将 BM25 文本相关性与向量相似度合并：

- `vectorWeight` — 余弦相似度的权重（默认 0.6）
- `textWeight` — BM25 文本匹配的权重（默认 0.4）
- `candidateMultiplier` — 重新排序前候选池的大小（默认 4）

<div id="embedding-providers-for-search">

### 搜索的嵌入提供者

</div>

| 提供者 | 描述 |
|---|---|
| `"local"` | 通过 node-llama-cpp 使用本地 GGUF 模型 |
| `"openai"` | OpenAI 嵌入 API |
| `"gemini"` | Google Gemini 嵌入 API |

<div id="memory-config-type">

## MemoryConfig 类型

</div>

`MemoryConfig` 类型控制内存后端的选择：

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

`qmd`（Quantum Memory Daemon）后端是一个替代内存存储，支持外部索引知识路径：

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

## 压缩

</div>

当对话上下文接近 token 限制时，压缩系统会总结较早的上下文。配置位于 `agents.defaults.compaction` 下：

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

| 模式 | 行为 |
|---|---|
| `"default"` | 通过 elizaOS 核心自动压缩进行标准压缩 |
| `"safeguard"` | 更激进的修剪，将历史记录限制在上下文窗口的 `maxHistoryShare` |

<div id="context-pruning">

## 上下文修剪

</div>

与压缩不同，上下文修剪会移除旧的工具结果，以减少活跃对话中的 token 使用：

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

## 知识集成

</div>

`knowledge` 提供 RAG（检索增强生成）知识管理。它作为核心插件加载，并与内存系统集成，基于向量相似度将相关知识片段注入代理上下文。

<div id="related-pages">

## 相关页面

</div>

- [运行时内存参考](/zh/runtime/memory) — MemoryManager 接口和检索 API
- [角色接口](./character-interface) — Character 的组装方式
- [运行时与生命周期](./runtime-and-lifecycle) — 内存初始化的时机
