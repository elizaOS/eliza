# 🌐 @elizaos/plugin-dpsn

> Decentralized Publish-Subscribe Network (DPSN) plugin for elizaOS agents

[![elizaOS](https://img.shields.io/badge/elizaOS-plugin-blue)](https://github.com/elizaOS/eliza)
[![Version](https://img.shields.io/badge/version-1.0.0--beta.2-brightgreen)](https://github.com/elizaOS/eliza)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 📋 Overview

The DPSN plugin enables elizaOS agents to subscribe any data streams available on [DPSN Data Streams Store](https://streams.dpsn.org/)

For more information, visit:

- [DPSN Official Website](https://dpsn.org)

## ✨ Features

- **Easy Integration**: Publish any realtime data to DPSN pub/sub topics and subscribe directly to your ElizaOS agent.
- **Real-time Updates**: Receive instant notifications when new messages are published
- **DPSN Marketplace feeds**: Subscribe to any dpsn stream listed over [DPSN Data Streams Store](https://streams.dpsn.org/) to directly start consuming data stream events.

## 🚀 Installation

```bash
# From within your elizaOS project
bun add @elizaos/plugin-dpsn
```

## ⚙️ Configuration

Add the following environment variables to your `.env` file:

```
DPSN_URL=betanet.dpsn.org
DPSN_WALLET_PVT_KEY=your_private_key_here
```

## 📚 Usage

### Subscribing to Topics

```typescript
import { DpsnService } from '@elizaos/plugin-dpsn';

// Get the DPSN service from the runtime
const dpsnService = runtime.getService('dpsn') as DpsnService;

// Subscribe to a topic
dpsnService.subscribe(
  '0xe14768a6d8798e4390ec4cb8a4c991202c2115a5cd7a6c0a7ababcaf93b4d2d4/BTCUSDT/ticker',
  (topic, message, packet) => {
    console.log(`Received message on ${topic}:`, message);
    // Handle the message
  }
);
```

## 📢 Publishing Data using DPSN

Here's how you can create topics, manage ownership, and publish data to DPSN:

[**→ Visit the DPSN Publishing Guide**](https://github.com/DPSN-org/dpsn-client-nodejs?tab=readme-ov-file#understanding-dpsn-topics)

## 📖 API Reference

### DpsnService

The main service class that provides DPSN functionality.

#### Methods

- `static async start(runtime: IAgentRuntime): Promise<DpsnService>` - Initialize and return a DpsnService instance
- `subscribe(topicName: string, callback: Function, subtopic?: string): void` - Subscribe to a topic
- `getDpsnClient(): DpsnClient` - Get the underlying DPSN client for advanced operations
- `async stop(): Promise<void>` - Stop the DPSN service and disconnect from the network

## 🔗 Related Projects

- [elizaOS](https://github.com/elizaOS/eliza) - The main elizaOS framework
- [DPSN Client](https://www.npmjs.com/package/dpsn-client) - The underlying client library for DPSN

> Incase of any queries please reach out to us on [Telegram](https://t.me/dpsn_dev) 📥.
