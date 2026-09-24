# @elizaos/plugin-google-workspace

Google Workspace integration for Gmail, Calendar, Drive, Meet, and People (Contacts)
with account-scoped OAuth, plus the Google Chat messaging connector (service-account
auth) and Google-owned assistant message projections.

Node-only integration. Enable the relevant Google APIs and configure `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` for OAuth. Pre-issued account tokens
can be injected without starting OAuth. Keep account scopes and token isolation intact;
Google Chat uses its separate service-account transport.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-google-workspace build  # build
bun run --cwd plugins/plugin-google-workspace test   # tests
```
