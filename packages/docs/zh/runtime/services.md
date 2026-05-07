---
title: "服务"
sidebarTitle: "服务"
description: "服务接口、服务注册表、内置服务列表、服务生命周期和依赖模式。"
---

服务是注册到 `AgentRuntime` 的长期运行后台组件。与提供者（每个回合运行）或操作（按需运行）不同，服务在其插件初始化时启动，并在代理的整个生命周期内运行。

<div id="service-interface">

## 服务接口

</div>

来自 `@elizaos/core`：

```typescript
export interface Service {
  serviceType: string;
  initialize(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}
```

| 字段 | 类型 | 描述 |
|---|---|---|
| `serviceType` | string | 此服务类型的唯一标识符（例如 `"AGENT_SKILLS_SERVICE"`） |
| `initialize()` | function | 当拥有此服务的插件初始化时调用一次 |
| `stop()` | function（可选） | 在优雅关闭时调用 |

<div id="service-registry">

## 服务注册表

</div>

服务可通过 runtime 访问：

```typescript
// Get a service by type string
const service = runtime.getService("AGENT_SKILLS_SERVICE");

// Get all services of a type (returns array for multi-instance services)
const services = runtime.getServicesByType("trajectories");

// Wait for a service to finish loading
const svcPromise = runtime.getServiceLoadPromise("AGENT_SKILLS_SERVICE");

// Check registration status
const status = runtime.getServiceRegistrationStatus("trajectories");
// Returns: "pending" | "registering" | "registered" | "failed" | "unknown"
```

<div id="core-plugins-and-their-services">

## 核心插件及其服务

</div>

核心插件始终加载，每个插件提供一个或多个服务：

| 插件 | 服务类型 | 描述 |
|---|---|---|
| `@elizaos/plugin-sql` | Database adapter | PGLite 或 PostgreSQL 持久化；提供 `runtime.adapter` |
| `@elizaos/plugin-local-embedding` | `TEXT_EMBEDDING` handler | 通过 node-llama-cpp 使用本地 GGUF 嵌入模型 |
| `@elizaos/core`（高级能力） | `FORM` | 结构化会话表单 — FormService、表单上下文与评估（在启用高级能力时加载；非独立 npm 插件） |
| `knowledge` | Knowledge service | RAG 知识索引和检索 |
| `trajectories` | `trajectories` | 调试和 RL 训练轨迹捕获 |
| `@elizaos/plugin-agent-orchestrator` | Orchestrator service | 多代理任务协调和生成 |
| `@elizaos/plugin-shell` | Shell service | 带安全控制的 shell 命令执行 |
| `@elizaos/plugin-coding-tools` | 文件/shell 沙箱相关服务 | 原生编码工具（READ、WRITE、EDIT、BASH、GREP、GLOB 等）；路径限定在工作区根目录 |
| `@elizaos/plugin-agent-skills` | `AGENT_SKILLS_SERVICE` | 技能目录加载和执行 |
| `@elizaos/plugin-commands` | Commands service | 斜杠命令处理（技能自动注册为 /commands） |
| 内置（`plugin_manager` / `@elizaos/core`） | Plugin manager service | 运行时动态安装/卸载插件 |
| `roles` | Roles service | 基于角色的访问控制（OWNER/ADMIN/NONE） |

<div id="optional-core-services">

## 可选核心服务

</div>

这些服务可用但默认不加载——通过管理面板或配置启用：

| 插件 | 描述 |
|---|---|
| `@elizaos/plugin-pdf` | PDF 文档处理 |
| `@elizaos/plugin-cua` | CUA 计算机使用代理（云沙箱自动化） |
| `@elizaos/plugin-obsidian` | Obsidian vault CLI 集成 |
| `@elizaos/plugin-repoprompt` | RepoPrompt CLI 集成 |
| `@elizaos/plugin-claude-code-workbench` | Claude Code 协作工作流 |
| `@elizaos/plugin-computeruse` | 计算机使用自动化（特定平台） |
| `@elizaos/plugin-browser` | 浏览器自动化（需要 stagehand-server） |
| `@elizaos/plugin-vision` | 视觉理解（功能门控） |
| `@elizaos/plugin-edge-tts` | 文本转语音（Microsoft Edge TTS） |
| `@elizaos/plugin-elevenlabs` | ElevenLabs 文本转语音 |
| `@elizaos/plugin-cli` | CLI 接口 |
| 内置（`enableSecretsManager` / `ENABLE_SECRETS_MANAGER`） | [`SECRETS` 服务](#secrets-secrets-service) — 加密凭证与引导（`@elizaos/core`） |
| `relationships` | 联系人图谱、关系记忆（静态导入，可能重新启用为核心） |
| `@elizaos/plugin-x402` | x402 HTTP 微支付协议 |

## Secrets (`SECRETS` service)

密钥由 **`@elizaos/core`** 提供（不再作为独立 npm 插件）。在角色或设置中启用 `enableSecretsManager: true` 或 `ENABLE_SECRETS_MANAGER`；运行时会注册 `SECRETS` 服务及相应 actions/providers，并在连接器与其他插件之前完成初始化。

密钥在静态存储时加密（AES-256-GCM），访问会记录审计（仅键名），并按代理隔离。可通过 **Agent → Settings → Secrets**、`eliza config path`、配置文件中的 `secrets` 段、启动环境变量，或插件内 `runtime.getSetting()` 使用（解析顺序通常为：数据库中的密钥、角色 `settings.secrets`、`process.env`、`~/.eliza/secrets` 下的全局密钥）。

审计日志仅通过 `SECRETS` 服务记录键名，从不记录明文值。

<div id="trajectory-logger-service">

## 轨迹日志服务

</div>

轨迹日志记录器在启动时被特殊处理。Eliza 在启用它之前会等待其可用，超时时间为 3 秒：

```typescript
await waitForTrajectoriesService(runtime, "post-init", 3000);
ensureTrajectoryLoggerEnabled(runtime, "post-init");
```

该服务支持 `isEnabled()` 和 `setEnabled(enabled: boolean)` 方法。Eliza 在初始化后默认启用它。

<div id="skills-service">

## 技能服务

</div>

`@elizaos/plugin-agent-skills` 加载和管理技能目录。Eliza 在启动后异步预热此服务：

```typescript
const svc = runtime.getService("AGENT_SKILLS_SERVICE") as {
  getCatalogStats?: () => { loaded: number; total: number; storageType: string };
};
const stats = svc?.getCatalogStats?.();
logger.info(`[eliza] Skills: ${stats.loaded}/${stats.total} loaded`);
```

技能按优先级顺序从多个目录中发现：

```
1. Workspace skills:  <workspaceDir>/skills/
2. Bundled skills:    from @elizaos/skills package
3. Extra dirs:        skills.load.extraDirs
```

技能通过 `skills.allowBundled` 和 `skills.denyBundled` 列表进行过滤。作为 runtime 设置转发：

```
BUNDLED_SKILLS_DIRS = <path from @elizaos/skills>
WORKSPACE_SKILLS_DIR = <workspaceDir>/skills
EXTRA_SKILLS_DIRS = <comma-separated extra dirs>
SKILLS_ALLOWLIST = <comma-separated allowed skill names>
SKILLS_DENYLIST = <comma-separated denied skill names>
```

<div id="sandbox-manager">

## Sandbox Manager

</div>

`SandboxManager` 来自 `src/services/sandbox-manager.ts`，当 `agents.defaults.sandbox.mode` 为 `"standard"` 或 `"max"` 时，提供基于 Docker 的代码执行隔离：

```typescript
const sandboxManager = new SandboxManager({
  mode: "standard",
  image: dockerSettings?.image ?? undefined,  // no default image — must be configured
  browser: dockerSettings?.browser ?? undefined,
  containerPrefix: "eliza-sandbox-",
  network: "bridge",
  memory: "512m",
  cpus: 0.5,
  workspaceRoot: workspaceDir,
});

await sandboxManager.start();
```

在 `"light"` 模式下，只创建审计日志——没有容器隔离。

<div id="service-lifecycle">

## 服务生命周期

</div>

```
插件已注册
    ↓
在 plugin.init() 期间调用 service.initialize(runtime)
    ↓
服务运行中（通过 runtime.getService() 可用）
    ↓
优雅关闭：调用 service.stop()
```

<div id="writing-a-service">

## 编写服务

</div>

在插件中创建服务：

```typescript
import type { IAgentRuntime, Service } from "@elizaos/core";

class MyService implements Service {
  serviceType = "MY_SERVICE";
  private runtime!: IAgentRuntime;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    // Start background work
    this.startPolling();
  }

  async stop(): Promise<void> {
    // Clean up resources
    this.stopPolling();
  }
}

// In the plugin:
export default {
  name: "my-plugin",
  description: "...",
  services: [new MyService()],
};
```

<div id="accessing-a-service-from-another-plugin">

## 从其他插件访问服务

</div>

服务通过类型字符串访问。如果服务可能未加载，请始终检查是否为 null：

```typescript
const myService = runtime.getService("MY_SERVICE") as MyService | null;
if (myService) {
  await myService.doSomething();
}
```

<div id="related-pages">

## 相关页面

</div>

- [核心运行时](/zh/runtime/core) — 插件加载和注册
- [运行时与生命周期](/zh/agents/runtime-and-lifecycle) — 服务启动时序
- [类型](/zh/runtime/types) — Service 接口类型定义
