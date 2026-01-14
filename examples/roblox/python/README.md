## Roblox agent bridge (Python)

This example runs a small **FastAPI** server that Roblox can call (`HttpService:RequestAsync`) to send chat messages to an elizaOS agent runtime.

### Environment variables

- `PORT` (default: `3041`)
- `ELIZA_ROBLOX_SHARED_SECRET` (recommended; must match `SHARED_SECRET` in the Luau script)
- `ROBLOX_ECHO_TO_GAME=true` (optional; publish agent replies back into Roblox via MessagingService)
- `OPENAI_API_KEY` (optional; if absent we fall back to `elizaos_plugin_eliza_classic`)

### Run

```bash
cd examples/roblox/python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Endpoints:
- `POST /roblox/chat`
- `GET /health`

