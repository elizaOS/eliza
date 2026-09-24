# @elizaos/auth

Shared login, account sessions, OAuth, and encrypted credential storage for elizaOS.

The root SDK is browser-safe. Use explicit Node subpaths for account authentication,
vault, and KMS. Preserve encrypted-storage compatibility and per-account refresh
coordination; never log credentials.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/auth build  # build
bun run --cwd packages/auth test   # tests
```
