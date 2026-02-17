<div align="center">
  <h1>elizaOS</h1>
  <p><strong>The Open-Source Framework for Multi-Agent AI Development</strong></p>
  <p>Build, deploy, and manage autonomous AI agents with a modern, extensible, and full-featured platform.</p>
</div>

<p align="center">
  <a href="https://trendshift.io/repositories/12591" target="_blank"><img src="https://trendshift.io/api/badge/repositories/12591" alt="elizaOS%2Feliza | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>
<div align="center">
  <a href="https://www.npmjs.com/package/@elizaos/core"><img src="https://img.shields.io/npm/dm/@elizaos/core" alt="Downloads" width=140 height=20></a>
  <a href="https://github.com/elizaOS/eliza/releases"><img src="https://img.shields.io/github/v/release/elizaOS/eliza" alt="Releases" width=94 height=20></a>
  <a href="https://arxiv.org/abs/2501.06781"><img src="https://img.shields.io/badge/arXiv-2501.06781-b31b1b.svg" alt="Paper" width=116 height=20></a>
  <a href="https://deepwiki.com/elizaOS/eliza"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" width=109 height=20></a>
</div>
<div align="center">
  <a href="https://github.com/elizaos/eliza/stargazers"><img src="https://img.shields.io/github/stars/elizaos/eliza?style=for-the-badge&logo=github" alt="GitHub Stars"></a>
  <a href="https://github.com/elizaos/eliza/network/members"><img src="https://img.shields.io/github/forks/elizaos/eliza?style=for-the-badge&logo=github" alt="GitHub Forks"></a>
  <a href="https://github.com/elizaos/eliza/commits"><img src="https://img.shields.io/github/last-commit/elizaos/eliza?style=for-the-badge" alt="Last Commit on GitHub"></a>
</div>

<div align="center">
  <a href="https://github.com/elizaos/eliza/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
  <a href="https://www.npmjs.com/package/@elizaos/cli"><img src="https://img.shields.io/npm/v/@elizaos/cli?style=for-the-badge" alt="NPM Version"></a>
  <a href="https://github.com/elizaos/eliza/graphs/contributors"><img src="https://img.shields.io/github/contributors/elizaos/eliza?style=for-the-badge" alt="Contributors"></a>
</div>
<div align="center">
  <a href="https://docs.elizaos.ai/"><img src="https://img.shields.io/badge/Documentation-Read%20Docs-blue?style=for-the-badge" alt="Documentation"></a>
  <!-- a href="https://github.com/elizaos/eliza/actions/workflows/image.yaml"><img src="https://img.shields.io/github/actions/workflow/status/elizaos/eliza/ci.yaml?branch=main&style=for-the-badge" alt="CI Status"></a -->
  <a href="https://twitter.com/elizaOS"><img src="https://img.shields.io/twitter/follow/elizaOS?style=for-the-badge&logo=x&label=Follow" alt="Follow on X"></a>
  <a href="https://discord.gg/ai16z"><img src="https://img.shields.io/discord/1253563208833433701?style=for-the-badge&logo=discord" alt="Discord"></a>
</div>

## ✨ What is Eliza?

elizaOS is an all-in-one, extensible platform for building and deploying AI-powered applications. Whether you're creating sophisticated chatbots, autonomous agents for business process automation, or intelligent game NPCs, Eliza provides the tools you need to get started quickly and scale effectively.

It combines a modular architecture with a library-first approach, giving you full control over your agents' development, deployment, and management lifecycle.

For complete guides and API references, visit our official **[documentation](https://docs.elizaos.ai/)**.

## 🚀 Key Features

- 🔌 **Rich Connectivity**: Out-of-the-box connectors for Discord, Telegram, Farcaster, and more.
- 🧠 **Model Agnostic**: Supports all major models, including OpenAI, Gemini, Anthropic, Llama, and Grok.
- 🖥️ **Modern Web UI**: A professional dashboard for managing agents, groups, and conversations in real-time.
- 🤖 **Multi-Agent Architecture**: Designed from the ground up for creating and orchestrating groups of specialized agents.
- 📄 **Document Ingestion**: Easily ingest documents and allow agents to retrieve information and answer questions from your data (RAG).
- 🛠️ **Highly Extensible**: Build your own functionality with a powerful plugin system.
- 📦 **It Just Works**: A seamless setup and development experience from day one.

## 🏁 Getting Started (5-Minute Quick Start)

Get your first AI agent running in just a few steps.

**Prerequisites:**

- [Node.js](https://nodejs.org/) (v23+)
- [bun](https://bun.sh/docs/installation)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required.

### 1. Clone the Repository

```bash
git clone https://github.com/elizaos/eliza.git
cd eliza
bun install
```

### 2. Configure Your API Key

Create a `.env` file in the project root:

```env
OPENAI_API_KEY=your_api_key_here
```

### 3. Run an Example Agent

```bash
# Interactive chat
OPENAI_API_KEY=your_key bun run examples/typescript/chat.ts

# Basic message processing
OPENAI_API_KEY=your_key bun run examples/typescript/standalone.ts
```

### 4. Use the Library in Your Own Project

Install the core package:

```bash
bun add @elizaos/core
```

Create an agent programmatically:

```typescript
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  character: {
    name: "MyAgent",
    bio: "A helpful AI assistant.",
  },
  plugins: [/* your plugins here */],
});

await runtime.initialize();
```

For complete guides and API references, visit our **[documentation](https://docs.elizaos.ai/)**.

## 🏛️ Architecture Overview

Eliza is a monorepo that contains all the packages needed to run the entire platform.

```
/
├── packages/
│   ├── typescript/     # Core package (@elizaos/core) - agent runtime, bootstrap plugin
│   ├── python/         # Python implementation of the core API
│   ├── rust/           # Rust implementation (native + WASM)
│   └── ...             # Other packages and utilities
├── plugins/            # Official plugins (discord, telegram, openai, etc.)
├── examples/           # Example agents and usage patterns
└── ...
```

- **`@elizaos/core`**: The core package that provides `AgentRuntime`, the bootstrap plugin, message processing, and basic agent actions.
- **`@elizaos/plugin-sql`**: Database integration (Postgres, PGLite).
- **`plugins/`**: Official plugins for Discord, Telegram, OpenAI, Anthropic, and many more.

## 🤝 How to Contribute

We welcome contributions from the community! Please read our `CONTRIBUTING.md` guide to get started.

- **Report a Bug**: Open an issue using the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template.
- **Request a Feature**: Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) template.
- **Submit a Pull Request**: Please open an issue first to discuss your proposed changes.

## 📜 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

## 🎓 Citation

If you use Eliza in your research, please cite our paper:

```bibtex
@article{walters2025eliza,
  title={Eliza: A Web3 friendly AI Agent Operating System},
  author={Walters, Shaw and Gao, Sam and Nerd, Shakker and Da, Feng and Williams, Warren and Meng, Ting-Chien and Han, Hunter and He, Frank and Zhang, Allen and Wu, Ming and others},
  journal={arXiv preprint arXiv:2501.06781},
  year={2025}
}
```

## Contributors

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" alt="Eliza project contributors" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)
