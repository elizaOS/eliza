# elizaOS Cloudflare Worker (Python)

A serverless AI agent running on Cloudflare Workers using Python.

> **Note**: Python Workers are currently in beta. Check [Cloudflare docs](https://developers.cloudflare.com/workers/languages/python/) for the latest status.

## Prerequisites

- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Python Workers enabled on your Cloudflare account

## Setup

```bash
# Set your API key
wrangler secret put OPENAI_API_KEY
```

## Development

```bash
# Run locally
wrangler dev
```

The worker will start at `http://localhost:8789`.

## Deploy

```bash
wrangler deploy
```

## API

Same as the TypeScript worker - see the parent [README](../README.md).

## Benefits of Python Worker

- **Familiar syntax**: Use Python you already know
- **Pyodide runtime**: Full Python standard library
- **Easy migration**: Port existing Python code easily



