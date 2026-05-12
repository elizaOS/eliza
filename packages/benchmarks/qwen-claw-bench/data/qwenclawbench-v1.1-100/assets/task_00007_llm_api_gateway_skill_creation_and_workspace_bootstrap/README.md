# OpenClaw Workspace

Personal OpenClaw agent workspace.

## Structure

```
.
├── .env                    # Environment variables & API keys
├── .openclaw/
│   ├── config.yaml         # Gateway configuration
│   └── gateway.log         # Runtime logs
├── models.json             # Available model providers & routing
├── scripts/
│   ├── setup_provider.sh   # Configure a new LLM provider
│   └── test_gpt4o.py       # Test GPT-4o API connectivity
├── skills/
│   ├── searxng/            # SearXNG local search skill
│   └── sample-skill/       # API integration template
└── AGENTS.md / SOUL.md / USER.md / etc.
```

## Adding an External LLM Provider

1. Edit `.env` and add your API key and base URL
2. Update `.openclaw/config.yaml` under `agent.providers`
3. Restart the gateway: `openclaw gateway restart`

Or use the setup script:
```bash
bash scripts/setup_provider.sh
```

## Models

See `models.json` for currently configured and available models.
