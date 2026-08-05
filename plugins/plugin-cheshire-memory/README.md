# @elizaos/plugin-cheshire-memory

Persistent **trading + chat** memory for Cheshire / Solizard agents.

## Keys

| Variable | Role |
| --- | --- |
| `HERMES_API_KEY` | Hermes vault / trade memory |
| `HERMES_API_URL` | optional base URL |
| `HONCHO_API_KEY` | Honcho peer dialectic memory |
| `HONCHO_BASE_URL` | optional base URL |
| `HONCHO_PEER_ID` | peer id (default agent name) |
| `HONCHO_SESSION_ID` | session id |
| `CHESHIRE_TRADING_MEMORY` | default true |

Never commit keys. Never log raw secrets.

## Actions / providers

- `REMEMBER_TRADE` — store trade note
- `RECALL_MEMORY` — query durable memory
- Provider `CHESHIRE_TRADING_MEMORY` — inject recent memory into state
