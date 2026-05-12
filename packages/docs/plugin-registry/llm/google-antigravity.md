---
title: "Google Antigravity Plugin"
sidebarTitle: "Google Antigravity"
description: "Google Cloud AI model provider for Eliza — access Google Cloud AI Platform models via the Antigravity integration."
---

The Google Antigravity plugin connects Eliza agents to Google Cloud AI Platform, providing access to Google's cloud-hosted AI models through the Google Cloud API. This is the Google Cloud (Vertex AI) integration, as opposed to the [Google Gemini plugin](/plugin-registry/llm/google-genai) which uses Google AI Studio.

<Info>
This plugin is available from the upstream elizaOS registry. It is **not bundled** in `plugins.json` and must be installed explicitly.
</Info>

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-google-antigravity`

## Installation

```bash
eliza plugins install @elizaos/plugin-google-antigravity
```

## Auto-Enable

The plugin auto-enables when `GOOGLE_CLOUD_API_KEY` is present:

```bash
export GOOGLE_CLOUD_API_KEY=your-google-cloud-api-key
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `GOOGLE_CLOUD_API_KEY` | Yes | Google Cloud API key with AI Platform access |

### eliza.json Example

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "google-antigravity"
      }
    }
  }
}
```

## When to Use This vs Google Gemini

| | Google Antigravity | Google Gemini |
|---|---|---|
| **API** | Google Cloud / Vertex AI | Google AI Studio |
| **Auth** | Google Cloud API key | Google AI Studio API key |
| **Best for** | Enterprise / GCP-integrated workloads | Quick start / personal use |
| **Env var** | `GOOGLE_CLOUD_API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY` |

## Features

- Google Cloud AI Platform model access
- Streaming responses
- Tool use / function calling
- Enterprise-grade authentication via Google Cloud

## Related

- [Google Gemini Plugin](/plugin-registry/llm/google-genai) — Google AI Studio / Gemini models
- [OpenAI Plugin](/plugin-registry/llm/openai) — GPT-4o models
- [Model Providers](/runtime/models) — Compare all providers
