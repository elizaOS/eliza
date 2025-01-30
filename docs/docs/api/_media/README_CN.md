# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

## 功能

- 🛠 支持discord/推特/telegram连接
- 👥 支持多模态agent
- 📚 简单的导入文档并与文档交互
- 💾 可检索的内存和文档存储
- 🚀 高可拓展性，你可以自定义客户端和行为来进行功能拓展
- ☁️ 多模型支持，包括Llama、OpenAI、Grok、Anthropic等
- 📦 简单好用

你可以用Eliza做什么？

- 🤖 聊天机器人
- 🕵️ 自主Agents
- 📈 业务流程自动化处理
- 🎮 游戏NPC

# 开始使用

**前置要求（必须）:**

- [Node.js 22+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Nodejs安装
- [pnpm](https://pnpm.io/installation)
- 使用pnpm

### 编辑.env文件

-   - 将 .env.example 复制为 .env 并填写适当的值
- 编辑推特环境并输入你的推特账号和密码

### 编辑角色文件

- 查看文件 `packages/core/src/defaultCharacter.ts` - 您可以修改它
- 您也可以使用 `node --loader ts-node/esm src/index.ts --characters="path/to/your/character.json"` 加载角色并同时运行多个机器人。

在完成账号和角色文件的配置后，输入以下命令行启动你的bot：

```
pnpm i
pnpm start
```

# 自定义Eliza

### 添加常规行为

为避免在核心目录中的 Git 冲突，我们建议将自定义操作添加到 custom_actions 目录中，并在 elizaConfig.yaml 文件中配置这些操作。可以参考 elizaConfig.example.yaml 文件中的示例。

## 配置不同的大模型

### 配置Llama

您可以通过设置 `XAI_MODEL` 环境变量为 `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` 或 `meta-llama/Meta-Llama-3.1-405B-Instruct` 来运行 Llama 70B 或 405B 模型

### 配置OpenAI

您可以通过设置 `XAI_MODEL` 环境变量为 `gpt-4o-mini` 或 `gpt-4o` 来运行 OpenAI 模型

## 其他要求

您可能需要安装 Sharp。如果在启动时看到错误，请尝试使用以下命令安装：

```
pnpm install --include=optional sharp
```

# 环境设置

您需要在 .env 文件中添加环境变量以连接到各种平台：

```
# Required environment variables
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Bot token
OPENAI_API_KEY=sk-* # OpenAI API key, starting with sk-
ELEVENLABS_XI_API_KEY= # API key from elevenlabs

# ELEVENLABS SETTINGS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Account username
TWITTER_PASSWORD= # Account password
TWITTER_EMAIL= # Account email

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=


# For asking Claude stuff
ANTHROPIC_API_KEY=

# EVM
EVM_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY

# Solana
SOLANA_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
SOLANA_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

# Fallback Wallet Configuration (deprecated)
WALLET_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=


## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# 本地设置

### CUDA设置

如果你有高性能的英伟达显卡，你可以以下命令行通过CUDA来做本地加速

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

确保你安装了完整的CUDA工具包，包括cuDNN和cuBLAS

### 本地运行

添加 XAI_MODEL 并将其设置为上述 [使用 Llama 运行](#run-with-llama) 中的选项之一
您可以将 X_SERVER_URL 和 XAI_API_KEY 留空，它会从 huggingface 下载模型并在本地查询

# 客户端

关于怎么设置discord bot，可以查看discord的官方文档

# 开发

## 测试

几种测试方法的命令行：

```bash
pnpm test           # Run tests once
pnpm test:watch    # Run tests in watch mode
```

对于数据库特定的测试：

```bash
pnpm test:sqlite   # Run tests with SQLite
pnpm test:sqljs    # Run tests with SQL.js
```

测试使用 Jest 编写，位于 src/\*_/_.test.ts 文件中。测试环境配置如下：

- 从 .env.test 加载环境变量
- 使用 2 分钟的超时时间来运行长时间运行的测试
- 支持 ESM 模块
- 按顺序运行测试 (--runInBand)

要创建新测试，请在要测试的代码旁边添加一个 .test.ts 文件。
