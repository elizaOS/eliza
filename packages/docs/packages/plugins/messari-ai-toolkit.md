# @elizaos/plugin-messari-ai-toolkit

A powerful Eliza OS plugin that integrates Messari's AI Toolkit to provide advanced crypto market research capabilities to your Eliza agent.

## Overview

This plugin connects your Eliza agent to Messari's comprehensive AI-powered APIs, enabling sophisticated crypto research and market analysis capabilities. It intelligently detects and processes research questions from conversations, leveraging Messari's proprietary data and expertise.

## Demo

https://github.com/messari/plugin-messari-ai-toolkit/blob/master/.github/assets/eliza-tutorial.mp4

## Features

- Seamless integration with Messari's AI-Toolkit `/chat/completions` API
- Intelligent detection of crypto-related research questions
- Real-time market data and asset metrics analysis
- Access to consolidated news summarizations
- Asset due diligence insights
- Fundraising and investment data visualization capabilities

## Usage Guide

### Setup

1. First, clone either:
   - The main Eliza repository: [github.com/elizaOS/eliza](https://github.com/elizaOS/eliza)
   - OR the Eliza starter repository: [github.com/elizaOS/eliza-starter](https://github.com/elizaOS/eliza-starter)

2. Install dependencies and build the project:
   ```bash
   pnpm install
   pnpm build
   ```

### Installing the Messari Plugin

Depending on which repository you cloned, use one of the following commands:

**For Main Eliza Repository:**
```bash
pnpm --filter agent add github:messari/plugin-messari-ai-toolkit
```

**For Eliza Starter:**
```bash
pnpm add github:messari/plugin-messari-ai-toolkit
```

> Note: For the latest plugin mappings and compatibility information, refer to the [eliza-plugins registry](https://github.com/elizaos-plugins/registry/blob/645ba61508a7404c5b890f47e43c005448592510/index.json#L60).

to use, import into `agent/index.ts` and add as a plugin


## Configuration

To use this plugin, you'll need a Messari API key. The Messari AI Toolkit is an enterprise product that requires:

1. An Enterprise (ENT) subscription
2. Purchase of the AI Toolkit service package + credits
3. API key generation

### Enterprise Access

The AI Toolkit subscription includes access to Messari's base package:
- Asset API
- News API
- Marketdata API

### Getting an API Key

1. Subscribe to Messari Enterprise
2. Purchase the AI Toolkit package
3. Visit [Messari Account Settings](https://messari.io/account/api) to generate your API key
4. Use the API key in your configuration

### API Endpoints

The Toolkit endpoints are accessible at `api.messari.io/ai`. For detailed API documentation, visit the [Messari Developer Docs](https://docs.messari.io/reference/chat-completion).

## Usage

1. Import and register the plugin with your Eliza agent
2. Configure your API key
3. Start asking crypto-related questions!

The plugin will automatically detect relevant research questions and query Messari's AI Toolkit for comprehensive answers.

## About Messari AI Toolkit

Messari's AI Toolkit is an enterprise-grade suite of AI-powered APIs designed specifically for the crypto ecosystem. It provides:

- Crypto-aware completions endpoint (OpenAI-compatible)
- Asset extraction on arbitrary documents
- Direct access to underlying agents
- News recaps and summarizations
- Deep understanding of crypto-specific terminology and context
- Real-time market data analysis

## Use Cases

- Market trend analysis with real-time data
- Automated crypto research and report generation
- News summarization across multiple sources
- Asset due diligence with Enterprise Diligence Reports
- Fundraising and investment data visualization
- Asset extraction and classification for document contextualization

## Security

This plugin requires secure handling of Messari API keys. Never expose your API key in your code or version control system.

## Performance Considerations

The plugin may introduce additional latency due to API calls. Consider implementing appropriate caching and error handling strategies in production environments.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Support

For questions about API access and testing, contact bijan.massoumi@messari.io.

For technical support with the plugin, please open an issue in the repository.
