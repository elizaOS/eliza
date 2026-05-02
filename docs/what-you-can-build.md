---
title: What You Can Build
sidebarTitle: What You Can Build
description: Explore the types of AI agents and applications you can create with Eliza — from autonomous social media agents to DeFi bots and customer support.
---

Eliza is a modular AI agent framework. Here's what people are building with it.

## Social Media Agents

Deploy agents across Twitter/X, Discord, Telegram, Slack, Farcaster, and 20+ other platforms that engage with communities, post content, and respond to mentions — all driven by a configurable character personality. A single character file controls posting cadence, tone, and auto-reply behavior across every connected platform.

```json
{
  "name": "Brand Bot",
  "bio": ["Social media manager that posts engaging content and responds to mentions"],
  "style": { "all": ["professional", "engaging", "concise"] },
  "connectors": {
    "twitter": {
      "apiKey": "...",
      "apiSecretKey": "...",
      "accessToken": "...",
      "accessTokenSecret": "...",
      "postEnable": true,
      "postIntervalMin": 60,
      "postIntervalMax": 120,
      "searchEnable": true,
      "autoRespondMentions": true
    }
  }
}
```

- Autonomous tweet composition and reply
- Multi-platform presence from a single character
- Keyword monitoring and engagement
- Content scheduling via triggers

**Plugins**: Discord, Telegram, Twitter, Slack, Farcaster, WhatsApp, and other platform connectors

---

## Community Support Agents

Build support agents that live in your Discord server and Telegram group simultaneously, drawing on a shared knowledge base to answer questions consistently. One character, multiple channels, zero duplication.

```json
{
  "name": "Support Agent",
  "bio": ["Technical support specialist for the community"],
  "connectors": {
    "discord": { "token": "..." },
    "telegram": { "botToken": "..." }
  },
  "plugins": { "allow": ["knowledge"] }
}
```

- Multi-channel support (Discord, Slack, Telegram, web)
- Ticket routing and escalation
- Knowledge base integration for consistent answers
- Conversation history and context across sessions

**Plugins**: Platform connectors, `knowledge` plugin

---

## DeFi & Trading Agents

Build on-chain agents that monitor markets, execute trades, and manage portfolios across EVM chains and Solana. The `cron` plugin handles scheduled strategy execution; the `browser` plugin can fetch live data from DeFi dashboards.

```json
{
  "name": "DeFi Watcher",
  "bio": ["Monitors DeFi protocols and executes strategies autonomously"],
  "plugins": { "allow": ["cron", "browser"] },
  "features": { "cron": true, "browser": true }
}
```

- Token swaps via DEX aggregators
- Portfolio rebalancing on schedule
- Price alert monitoring and notifications
- Multi-chain wallet management

**Plugins**: EVM, Solana, wallet, `cron`, `browser` plugins

---

## Knowledge Assistants

Create agents that answer questions from your documentation, codebase, or custom knowledge base using RAG (Retrieval-Augmented Generation). Upload documents once; the agent embeds and indexes them automatically.

```json
{
  "name": "Research Assistant",
  "bio": ["Answers questions using uploaded knowledge documents"],
  "plugins": { "allow": ["knowledge"] }
}
```

- Document ingestion and embedding
- Semantic search across your knowledge base
- Context-aware responses grounded in your content
- Continuous learning from new uploads

**Plugins**: `knowledge` plugin

---

## Creative Agents

Build agents that generate images, compose audio narration, write content, and engage creatively with users. Enable `imageGen` and `tts` in the features block to activate the relevant providers.

```json
{
  "name": "Art Studio",
  "bio": ["Creates images, videos, and audio on demand"],
  "features": { "imageGen": true, "tts": true }
}
```

- Image generation via DALL-E, Stable Diffusion
- Text-to-speech for voice content
- Content writing with a consistent character voice
- Multi-modal interactions combining text and media

**Plugins**: Image generation, TTS plugins

---

## Browser Automation Agents

Create agents that browse the web, fill forms, extract data, and automate multi-step workflows. Useful for research pipelines, monitoring pages for changes, or scraping data on a schedule.

- Web scraping and data extraction
- Form filling and submission
- Screenshot analysis
- Multi-step web workflows

**Plugins**: `browser`, computer-use plugins

---

## DevOps & Monitoring Agents

Build agents that monitor infrastructure, respond to alerts, and automate operational tasks on a cron schedule. Results can be posted directly to a Slack or Discord channel.

- Log monitoring and alerting
- Scheduled health checks via cron
- Incident response automation
- Status reporting to team channels

**Plugins**: `cron`, platform connectors

---

## Multi-Agent Systems

Orchestrate multiple agents that collaborate, share knowledge, and specialize in different tasks. Agents communicate via the runtime message bus and can hand off work to each other.

- Agent-to-agent communication
- Shared knowledge bases
- Role-based specialization
- Workflow orchestration

---

## Getting Started

Pick a use case above and follow these steps:

1. [Install Eliza](/installation)
2. Choose or connect to a server target
3. Install relevant plugins for your use case
4. Configure connectors for your platforms
5. Deploy with [cloud](/guides/cloud) or [self-host](/deployment)

## Related

- [Quickstart](/quickstart) — Build your first agent
- [Plugins Overview](/plugins/overview) — Browse available capabilities
- [Architecture](/architecture) — Understand the system design
