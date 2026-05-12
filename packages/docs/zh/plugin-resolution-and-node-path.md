<div id="plugin-resolution-why-node_path-is-needed">
# 插件解析：为什么需要 NODE_PATH
</div>

本文档解释**为什么**没有 `NODE_PATH` 时动态插件导入会失败，以及**如何**在 CLI、开发服务器和 Electrobun 中修复它。

<div id="the-problem">
## 问题
</div>

运行时（`src/runtime/eliza.ts`）通过动态导入加载插件：

```ts
import("@elizaos/plugin-sql")
```

Node 通过从**导入文件的目录**向上遍历来解析。当 eliza 从不同位置运行时，解析可能失败：

| 入口点 | 导入文件位置 | 向上遍历起点 | 能到达根 `node_modules`？ |
|---|---|---|---|
| `bun run dev` | `src/runtime/eliza.ts` | `src/runtime/` | 通常可以（2 级） |
| `eliza start`（CLI） | `dist/runtime/eliza.js` | `dist/runtime/` | 通常可以（2 级） |
| Electrobun dev | `eliza-dist/eliza.js` | `apps/app/electrobun/eliza-dist/` | **不能** — 进入 `apps/` |
| Electrobun 打包 | `app.asar.unpacked/eliza-dist/eliza.js` | `.app` bundle 内部 | **不能** — 不同的文件系统 |

在 Electrobun 的情况下（有时也包括编译后的 dist，取决于打包器行为），遍历永远不会到达安装了 `@elizaos/plugin-*` 包的仓库根目录。导入失败并报 "Cannot find module"。

<div id="the-fix-node_path">
## 修复方案：NODE_PATH
</div>

`NODE_PATH` 是一个 Node.js 环境变量，用于向模块解析添加额外目录。我们在**三个地方**设置它，使每个入口路径都能解析插件：

<div id="1-srcruntimeelizats-module-level">
### 1. `src/runtime/eliza.ts`（模块级）
</div>

```ts
const _repoRoot = path.resolve(_elizaDir, "..", "..");
const _rootModules = path.join(_repoRoot, "node_modules");
if (existsSync(_rootModules)) {
  process.env.NODE_PATH = ...;
  Module._initPaths();
}
```

**为什么在这里：** 覆盖 `bun run dev`（dev-server.ts 直接导入 eliza）和任何其他进程内导入 eliza 的情况。`existsSync` 守卫意味着在仓库根目录不存在的打包应用中这是空操作。

**关于 `Module._initPaths()` 的说明：** 这是一个 Node.js 私有 API，但被广泛用于此目的（运行时 NODE_PATH 变更）。Node 在启动时缓存解析路径；在设置 `process.env.NODE_PATH` 后我们必须调用它，以便下一个 `import()` 看到新路径。

<div id="2-scriptsrun-nodemjs-child-process-env">
### 2. `scripts/run-node.mjs`（子进程环境）
</div>

```js
const rootModules = path.join(cwd, "node_modules");
env.NODE_PATH = ...;
```

**为什么在这里：** CLI 执行器生成一个运行 `eliza.mjs` → `dist/entry.js` → `dist/eliza.js` 的子进程。在子进程的 env 中设置 `NODE_PATH` 确保子进程从根目录解析，即使 `dist/` 没有自己的 `node_modules`。

<div id="3-appsappelectrobunscrnativeagentts-electrobun-native-runtime">
### 3. `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts`（Electrobun 原生运行时）
</div>

```ts
// Dev: walk up from __dirname to find node_modules
// Packaged: use ASAR node_modules
```

**为什么在这里：** Electrobun 原生运行时通过 `dynamicImport()` 加载 `eliza-dist/eliza.js`。在开发模式下，`__dirname` 深入 `apps/app/electrobun/build/src/native/` — 我们向上遍历找到第一个 `node_modules` 目录（monorepo 根目录）。在打包模式下，我们使用 ASAR 的 `node_modules`。

<div id="why-not-just-use-the-bundler">
## 为什么不直接使用打包器？
</div>

使用 `noExternal: [/.*/]` 的 tsdown 内联了大多数依赖，但 `@elizaos/plugin-*` 包是通过**运行时动态导入**加载的（插件名来自配置，而非静态导入）。打包器无法内联它们，因为它不知道将加载哪些插件。它们必须在运行时可解析。

<div id="packaged-app-no-op">
## 打包应用：空操作
</div>

在打包的 `.app` 中，`eliza.js` 位于 `app.asar.unpacked/eliza-dist/eliza.js`。上两级是 `Contents/Resources/` — 那里没有 `node_modules`。`eliza.ts` 中的 `existsSync` 检查返回 false，因此 NODE_PATH 代码被完全跳过。打包应用在桌面构建期间将运行时包复制到 `eliza-dist/node_modules`（Electrobun 的 `copy-runtime-node-modules.ts`），`agent.ts` 将该打包的 `node_modules` 目录设置到 `NODE_PATH`。

<div id="bun-and-published-package-exports">
## Bun 和已发布包的导出
</div>

一些 `@elizaos` 包（例如 `@elizaos/plugin-sql`）发布的 `package.json` 中带有 `exports["."].bun = "./src/index.ts"`。**为什么这样做：** 在上游 monorepo 中，Bun 可以直接运行 TypeScript，因此指向 `src/` 避免了构建步骤。然而，发布的 npm tarball 只包含 `dist/` — `src/` 不会被发布。当我们从 npm 安装时，`"bun"` 条件指向一个不存在的路径。

**会发生什么：** Bun 的解析器优先使用 `"bun"` 导出条件。它尝试加载 `./src/index.ts`，文件不存在，我们得到 "Cannot find module … from …/src/runtime/eliza.ts"，即使包在 `node_modules` 中。当 `"bun"` 目标缺失时，Bun 不会回退到 `"import"` 条件。

**我们的修复：** `scripts/patch-deps.mjs` 在 `bun install` 之后通过 `scripts/run-repo-setup.mjs`（被 `postinstall` 和应用构建引导使用）运行。它对需要修复的已安装 `@elizaos` 包运行补丁；如果 `exports["."].bun` 指向 `./src/index.ts` 且该文件不存在，则删除引用 `src/` 的 `"bun"` 和 `"default"` 条件。补丁后，只剩下 `"import"`（和类似条件），因此 Bun 解析到 `./dist/index.js`。**为什么只在文件缺失时打补丁：** 在插件以 `src/` 存在的方式签出的开发工作空间中，我们保持包不变，以便上游工作流继续正常工作。

<div id="pinned-elizaosplugin-openrouter">
## 固定：`@elizaos/plugin-openrouter`
</div>

当不使用本地签出时，根 `package.json` 固定为 **`2.0.0-alpha.13`**（当前已知良好的 npm tarball）。**`2.0.0-alpha.12`** 发布了损坏的 dist 入口点，必须避免使用。

<div id="what-went-wrong-in-200-alpha12">
### `2.0.0-alpha.12` 出了什么问题
</div>

**`2.0.0-alpha.12`** 发布的 npm tarball 包含 Node ESM 和浏览器入口点的**截断** JavaScript 输出（`dist/node/index.node.js`、`dist/browser/index.browser.js`）。这些文件只包含打包的 `utils/config` 辅助函数（~80 行）。**主要插件实现**（应该作为 `openrouterPlugin` 和 `default` 导出的对象）在文件中**不存在**，但最终的 `export { … }` 列表仍然命名了 `openrouterPlugin` 和 `openrouterPlugin2 as default`。

**为什么 Bun 报错：** 当运行时加载插件时，Bun 构建/转译该入口文件并以类似 *`openrouterPlugin` is not declared in this file* 的错误失败 — 符号被导出但从未定义。CommonJS 构建（`dist/cjs/index.node.cjs`）以相同方式不完整（导出 getter 引用缺失的 `import_plugin` chunk）。

**为什么我们不在 postinstall 中修补 dist：** 损坏的发布缺少整个插件主体，而非单个错误标识符（对比 `@elizaos/plugin-pdf`，其中一个小的字符串替换即可修复错误的导出别名）。在 Eliza 中从源码重建插件将会 fork 上游且很脆弱。当你不使用本地工作空间签出时，请优先使用已知良好的 **`2.0.0-alpha.13`** 发布工件。

<div id="maintainer-notes">
### 维护者说明
</div>

- **在升级** OpenRouter 依赖之前，验证 npm 上的**已发布 tarball**：打开 `dist/node/index.node.js` 并确认它定义了 default export / `openrouterPlugin`，或在安装后运行 `bun build node_modules/@elizaos/plugin-openrouter/dist/node/index.node.js --target=bun`。
- **在上游发布修复版本且你已确认工件之前，不要将工作空间链接替换为无约束的 semver 范围**。**原因：** `^2.0.0-alpha.13` 允许 Bun 解析到损坏的版本，这破坏了升级 lockfile 的安装。

OpenRouter 本身的面向用户的上下文和配置位于 **[OpenRouter 插件](plugin-registry/llm/openrouter.md)**（Mintlify：`/plugin-registry/llm/openrouter`）。

<div id="optional-plugins-why-was-this-package-in-the-load-set">
## 可选插件：为什么这个包在加载集中？
</div>

可选插件（和一些核心相邻包）可能因为 **`plugins.allow`**、**`plugins.entries`**、**连接器**配置、**`features.*`**、**环境变量**（例如触发自动启用的提供者 API 密钥或钱包密钥）或 **`plugins.installs`** 而最终进入加载集。当解析失败并显示**缺少 npm 模块**或**缺少浏览器 stagehand** 时，日志过去看起来像通用运行时错误。

**为什么我们记录来源：** `collectPluginNames()` 可选地填充一个 **`PluginLoadReasons`** 映射（每个包的第一个来源优先）。`resolvePlugins()` 传递它；良性的可选失败被总结为 **`Optional plugins not installed: … (added by: …)`**。这回答了"我该更改什么？" — 编辑配置、取消设置环境变量、安装包或添加插件签出 — 而不是追逐"eliza 坏了"的错误假设。

**Browser / stagehand：** `@elizaos/plugin-browser` 期望一个**不在** npm tarball 中的 **stagehand-server** 树。Eliza 通过从运行时**向上遍历父目录**来发现 `plugins/plugin-browser/stagehand-server`，使得 Eliza 平面签出和 **`eliza/` 子模块**布局都能解析。参见**[开发者诊断和工作空间](/zh/guides/developer-diagnostics-and-workspace)**。
