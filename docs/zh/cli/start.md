---
title: "milady start"
sidebarTitle: "start"
description: "以仅服务器模式启动 Milady 代理运行时。"
---

以无界面服务器模式启动 elizaOS 代理运行时。运行时以 `serverOnly` 模式启动，这意味着 API 服务器和代理循环会启动，但不会启动交互式聊天界面。`run` 命令是 `start` 的直接别名。

<div id="usage">

## 用法

</div>

```bash
milady start
milady run     # start 的别名
```

<div id="options">

## 选项

</div>

| 标志 | 描述 |
|------|------|
| `--connection-key [key]` | 设置或自动生成用于远程访问的连接密钥。传入一个值以使用特定密钥，或不带值传入该标志以自动生成一个。该密钥会被设置为会话的 `MILADY_API_TOKEN`。当绑定到非 localhost 地址时（例如 `MILADY_API_BIND=0.0.0.0`），如果未配置密钥，则会自动生成一个。 |

同样适用的全局标志：

| 标志 | 描述 |
|------|------|
| `-v, --version` | 打印当前 Milady 版本并退出 |
| `--help`, `-h` | 显示此命令的帮助信息 |
| `--profile <name>` | 使用命名的配置文件（状态目录变为 `~/.milady-<name>/`） |
| `--dev` | `--profile dev` 的简写（同时将网关端口设置为 `19001`） |
| `--verbose` | 启用信息级别的运行时日志 |
| `--debug` | 启用调试级别的运行时日志 |
| `--no-color` | 禁用 ANSI 颜色 |

<div id="examples">

## 示例

</div>

```bash
# 以服务器模式启动代理运行时
milady start

# 使用 run 别名启动
milady run

# 使用命名配置文件启动（隔离的状态目录）
milady --profile production start

# 使用 dev 配置文件启动
milady --dev start

# 使用自动生成的连接密钥启动（用于远程访问）
milady start --connection-key

# 使用特定的连接密钥启动
milady start --connection-key my-secret-key
```

<div id="behavior">

## 行为

</div>

当你运行 `milady start` 时：

1. CLI 从 elizaOS 运行时调用 `startEliza({ serverOnly: true })`。
2. 在生产环境中（`milady start`），API 服务器默认在端口 `2138` 上启动（可通过 `MILADY_PORT` 或 `ELIZA_PORT` 覆盖）。在开发模式中（`bun run dev`），API 运行在端口 `31337`（`MILADY_API_PORT`），而仪表盘 UI 使用 `2138`（`MILADY_PORT`）。
3. 代理循环开始处理来自已连接客户端和消息平台的消息。
4. 不会启动交互式界面——进程以无界面模式运行。

`run` 命令是一个直接别名，调用完全相同的 `startEliza({ serverOnly: true })` 函数。

<div id="environment-variables">

## 环境变量

</div>

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `MILADY_PORT` | API 服务器端口（也接受 `ELIZA_PORT` 作为备选） | `2138` |
| `MILADY_STATE_DIR` | 状态目录覆盖 | `~/.milady/` |
| `MILADY_CONFIG_PATH` | 配置文件路径覆盖 | `~/.milady/milady.json` |

<div id="deployment">

## 部署

</div>

`milady start` 是以下场景的推荐入口：

- 生产部署
- Docker 容器
- CI/CD 环境
- 任何无界面或服务器环境

使用你偏好的进程管理器来保持代理运行：

```bash
# 使用 pm2
pm2 start "milady start" --name milady

# 使用 systemd（创建服务单元）
ExecStart=/usr/local/bin/milady start

# 在 Dockerfile 中
CMD ["milady", "start"]
```

API 服务器在配置中启用 `commands.restart` 时，支持通过 `POST /api/agent/restart` 进行热重启。

<div id="related">

## 相关

</div>

- [milady setup](/zh/cli/setup) —— 在启动前初始化配置和工作区
- [环境变量](/zh/cli/environment) —— 所有环境变量
- [配置](/zh/configuration) —— 完整的配置文件参考
