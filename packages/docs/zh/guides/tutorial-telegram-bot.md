---
title: "教程：Telegram 机器人"
sidebarTitle: "Telegram 机器人设置"
description: "了解如何在几分钟内使用 Eliza 创建和配置 Telegram 机器人"
---

<div id="tutorial-telegram-bot">
# 教程：Telegram 机器人
</div>

开始使用 Eliza 的 Telegram 机器人集成。本教程将引导你完成创建第一个机器人、配置以及端到端测试的全过程。

<Info>
  本教程假设你已经安装了 Eliza。如果还没有，请查看[安装指南](/zh/installation)。
</Info>

<div id="prerequisites">
## 前提条件
</div>

开始之前，请确保你拥有：

- 一个 Telegram 账户
- 已安装并运行的 Eliza（`bun run dev`）
- 对 Eliza 控制面板的访问权限（默认：http://localhost:2138）

<div id="quick-setup-via-dashboard">
## 通过控制面板快速设置
</div>

通过 Eliza 控制面板设置 Telegram 连接器是最快的方式：

1. 在浏览器中打开 **http://localhost:2138**
2. 在顶部导航栏中进入 **Connectors**
3. 在连接器列表中找到 **Telegram** 并将其切换为 **ON**
4. 粘贴你的 **Bot Token**（请参见下方了解如何获取）
5. 点击 **Save Settings** — 代理将自动重启
6. 点击 **Test Connection** 进行验证 — 你应该会看到 "Connected as @yourbotname"
7. 打开 Telegram，通过用户名搜索你的机器人，发送 `/start`

就这样 — 你的机器人已经上线了。

<div id="getting-a-bot-token-from-botfather">
## 从 BotFather 获取机器人令牌
</div>

<Steps>
  <Step title="使用 BotFather 创建机器人">
    打开 Telegram 并搜索 **@BotFather**，这是用于创建 Telegram 机器人的官方机器人。

    1. 点击 "Start" 按钮开始与 @BotFather 的对话
    2. 发送命令：`/newbot`
    3. BotFather 会要求你为机器人选择一个名称（这是显示名称）
    4. 为你的机器人选择一个唯一的用户名（必须以 "bot" 结尾）
    5. BotFather 将回复你的 **bot token** — 请妥善保存

    <Warning>
      切勿公开分享你的机器人令牌或将其提交到版本控制系统中。它授予对你机器人的完全访问权限。
    </Warning>

    你的令牌将类似于：`123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI`
  </Step>

  <Step title="获取已有的令牌">
    如果你已经有一个机器人，可以随时获取令牌：

    1. 向 @BotFather 发送 `/mybots`
    2. 从列表中选择你的机器人
    3. 选择 "API Token"

    要重新生成被泄露的令牌，请在同一菜单中选择 "Revoke current token"。这将立即使旧令牌失效。
  </Step>
</Steps>

<div id="dashboard-features">
## 控制面板功能
</div>

<div id="test-connection">
### 测试连接
</div>

保存机器人令牌后，在连接器设置中点击 **Test Connection**。这将调用 Telegram 的 `getMe` API 并验证你的令牌是否有效。你会看到以下结果之一：

- **"Connected as @yourbotname"** — 你的机器人已就绪
- **"Telegram API error: ..."** — 请检查你的令牌

<div id="chat-access-toggle">
### 聊天访问控制
</div>

默认情况下，你的机器人设置为 **Allow all chats** — 任何向其发送消息的人都会收到回复。要限制访问：

1. 点击 **Allow all chats** 切换按钮以切换到 **Allow only specific chats**
2. 将出现一个输入框 — 输入允许的聊天 ID 的 JSON 数组，例如：
   ```json
   ["123456789", "-1001234567890"]
   ```
3. 点击 **Save Settings**

要切换回来，再次点击切换按钮以返回 **Allow all chats** — 如果你再次切换到特定聊天模式，之前保存的聊天 ID 将被恢复。

聊天 ID 格式：
- **正数**（例如 `123456789`）— 与单个用户的私聊
- **以 -100 开头的负数**（例如 `-1001234567890`）— 群组和超级群组

要查找你的聊天 ID，请在 Telegram 上使用 [@userinfobot](https://t.me/userinfobot)。

对允许聊天的更改会立即生效 — 无需重启。

<div id="show--hide-token">
### 显示 / 隐藏令牌
</div>

点击 Bot Token 字段旁边的 **Show** 按钮以显示已保存的令牌值。点击 **Hide** 再次隐藏。

<div id="reset">
### 重置
</div>

点击 **Reset** 以清除所有已保存的 Telegram 设置（令牌、允许的聊天等）。这将提示确认并重启代理。之后你需要重新配置连接器。

<div id="advanced-settings">
### 高级设置
</div>

点击 **Advanced** 展开附加设置：

- **API Root** — 自定义 Telegram Bot API 端点（默认：`https://api.telegram.org`）。仅在你运行[本地 Bot API 服务器](https://core.telegram.org/bots/api#using-a-local-bot-api-server)或使用代理时需要。
- **Test Chat ID** — 自动化测试套件使用的聊天 ID。生产环境不需要。

<div id="configuration-via-elizajson">
## 通过 eliza.json 配置
</div>

你也可以直接在 `~/.eliza/eliza.json` 中配置 Telegram 连接器：

```json
{
  "env": {
    "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI"
  }
}
```

或在项目根目录中使用 `.env` 文件：

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI
```

然后启动 Eliza：

```bash
bun run dev
```

<div id="configuration-parameters">
## 配置参数
</div>

| 参数 | 必需 | 描述 |
|------|------|------|
| **Bot Token** (`TELEGRAM_BOT_TOKEN`) | 是 | 来自 @BotFather 的认证令牌。这是唯一需要的启动参数。 |
| **Allowed Chats** (`TELEGRAM_ALLOWED_CHATS`) | 否 | 机器人允许交互的聊天 ID 的 JSON 数组。如果未设置，机器人将回复所有聊天。 |
| **API Root** (`TELEGRAM_API_ROOT`) | 否 | 自定义 Telegram Bot API 端点。默认为 `https://api.telegram.org`。 |
| **Test Chat ID** (`TELEGRAM_TEST_CHAT_ID`) | 否 | E2E 测试套件使用的聊天 ID。生产环境不需要。 |

<div id="troubleshooting">
## 故障排除
</div>

<AccordionGroup>
  <Accordion title="机器人令牌无效或无法使用">
    **问题：** 你收到类似 "Unauthorized" 的错误，或者 Test Connection 按钮显示 "Telegram API error"

    **解决方案：**
    1. 仔细检查是否完整正确地复制了令牌
    2. 确认令牌未被撤销 — 在 BotFather 中查看 `/mybots`
    3. 确保没有多余的空格或换行符
    4. 如有需要，在 BotFather 中重新生成令牌（这将使旧令牌失效）
    5. 粘贴新令牌后，点击 **Save Settings** 然后点击 **Test Connection**
  </Accordion>

  <Accordion title="NEEDS SETUP 标记不消失">
    **问题：** 即使令牌已保存，Telegram 连接器仍显示 "Needs setup"

    **解决方案：**
    1. 只有 **Bot Token** 是必填的 — 其他字段是可选的
    2. 点击 **Save Settings** 保存你的令牌
    3. 刷新页面 — 标记应该变为 "Ready"
    4. 如果标记仍然存在，请检查终端中的错误消息
  </Accordion>

  <Accordion title="机器人没有收到消息">
    **问题：** 你发送了消息但机器人没有回复

    **解决方案：**
    1. 确认连接器在控制面板中已切换为 **ON**
    2. 检查 Test Connection 是否显示 "Connected as @yourbotname"
    3. 在运行 Eliza 的终端中查找错误消息
    4. 如果聊天访问受限，请确认你的聊天 ID 在允许列表中
    5. 确保你先向机器人发送了 `/start`
    6. 尝试重启 Eliza — 连接器可能需要重新启动
  </Accordion>

  <Accordion title="机器人响应缓慢">
    **问题：** 消息延迟或机器人似乎无响应

    **解决方案：**
    1. 检查你的网络连接
    2. 监控系统资源 — 内存或 CPU 可能已满载
    3. 检查 Eliza 日志中的错误或挂起的进程
    4. 对于生产环境，考虑使用 webhook 模式而非轮询
  </Accordion>

  <Accordion title="日志中出现 409 Conflict 错误">
    **问题：** 日志显示 "409: Conflict: terminated by other getUpdates request"

    **解决方案：**
    1. 确保只有一个 Eliza 实例在运行
    2. 检查是否有残留的机器人进程：`tasklist | grep bun`（Windows）或 `ps aux | grep bun`（Linux/Mac）
    3. 等待 30 秒后重启 — Telegram 需要时间释放轮询槽位
  </Accordion>
</AccordionGroup>

<div id="next-steps">
## 后续步骤
</div>

- **[连接器指南](../guides/connectors.md)** — 所有可用连接器的概述
- **[配置指南](../guides/config-templates.md)** — 高级配置选项
- **[部署指南](../guides/deployment.md)** — 将你的机器人部署到生产环境

<div id="need-help">
## 需要帮助？
</div>

- 加入 [Eliza Discord 社区](https://discord.gg/eliza)
- 在 [GitHub](https://github.com/eliza-ai/eliza/issues) 上报告问题
