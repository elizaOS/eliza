---
title: "eliza configure"
sidebarTitle: "configure"
description: "显示配置指南和常用环境变量。"
---

在终端中打印配置快速参考。`configure` 命令是一个信息指南——它展示如何读取配置值、为模型提供商设置哪些环境变量，以及在哪里直接编辑配置文件。它不会修改任何文件或设置。

<div id="usage">

## 用法

</div>

```bash
eliza configure
```

<div id="options">

## 选项

</div>

`eliza configure` 除标准全局标志外不接受其他选项。

| 标志 | 描述 |
|------|-------------|
| `-v, --version` | 打印当前 Eliza 版本并退出 |
| `--help`, `-h` | 显示此命令的帮助信息 |
| `--profile <name>` | 使用命名配置文件（状态目录变为 `~/.eliza-<name>/`） |
| `--dev` | `--profile dev` 的简写（同时将网关端口设置为 `19001`） |
| `--verbose` | 启用信息级运行时日志 |
| `--debug` | 启用调试级运行时日志 |
| `--no-color` | 禁用 ANSI 颜色 |

<div id="example">

## 示例

</div>

```bash
eliza configure
```

<div id="output">

## 输出

</div>

运行 `eliza configure` 会在终端中打印以下信息：

```
Eliza Configuration

Set values with:
  eliza config get <key>     Read a config value
  Edit ~/.eliza/eliza.json directly for full control.

Common environment variables:
  ANTHROPIC_API_KEY    Anthropic (Claude)
  OPENAI_API_KEY       OpenAI (GPT)
  AI_GATEWAY_API_KEY   Vercel AI Gateway
  GOOGLE_API_KEY       Google (Gemini)
```

<div id="common-environment-variables">

## 常用环境变量

</div>

以下环境变量用于配置 AI 模型提供商的访问。在你的 shell 配置文件（例如 `~/.zshrc` 或 `~/.bashrc`）、`~/.eliza/.env` 中，或者在工作目录的 `.env` 文件中设置它们。

| 环境变量 | 提供商 |
|---------------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `GROQ_API_KEY` | Groq |
| `XAI_API_KEY` | xAI (Grok) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `TOGETHER_API_KEY` | Together AI |
| `MISTRAL_API_KEY` | Mistral |
| `COHERE_API_KEY` | Cohere |
| `PERPLEXITY_API_KEY` | Perplexity |
| `OLLAMA_BASE_URL` | Ollama（本地，无需 API 密钥） |

有关支持的提供商及其环境变量的完整列表，请参阅 [eliza models](/zh/cli/models) 和[环境变量](/zh/cli/environment)。

<div id="setting-configuration-values">

## 设置配置值

</div>

`eliza configure` 是只读的。要实际更改配置，请使用以下方法之一：

**读取一个值：**
```bash
eliza config get gateway.port
eliza config get agents.defaults.workspace
```

**检查所有值：**
```bash
eliza config show
eliza config show --all      # 包含高级字段
eliza config show --json     # 机器可读输出
```

**查找配置文件：**
```bash
eliza config path
# Output: /Users/you/.eliza/eliza.json
```

**直接编辑：**
```bash
# 在编辑器中打开
$EDITOR ~/.eliza/eliza.json
```

<div id="related">

## 相关内容

</div>

- [eliza config](/zh/cli/config) -- 使用 `get`、`path` 和 `show` 子命令读取和检查配置值
- [eliza models](/zh/cli/models) -- 检查已配置的模型提供商
- [eliza setup](/zh/cli/setup) -- 初始化配置文件和工作区
- [环境变量](/zh/cli/environment) -- 完整的环境变量参考
- [配置参考](/zh/configuration) -- 完整的配置文件架构和所有可用设置
