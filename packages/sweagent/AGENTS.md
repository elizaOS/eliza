# @elizaos/sweagent-root

Security-patched vendor sources for SWE-agent (GHSA-jvqc-qp6c-g58f, GHSA-w846-hghr-xmrc). Not a published elizaOS plugin.

## Purpose / role

This package holds security-remediated copies of upstream SWE-agent sources (Python inspector and TypeScript tools). The full SWE-agent build graph is **not vendored on the `develop` branch** — this directory exists for cherry-pick, npm release, or private-fork publication. No other package in the elizaOS monorepo imports from here at runtime.

## Layout

```
packages/sweagent/
  package.json                  # private, @elizaos/sweagent-root, no exports
  vitest.config.ts              # node environment; runs security/__tests__
  SECURITY.md                   # CVE details and deployment guidance

  security/                     # Shared security helpers (tested)
    safe-path.ts                # resolvePathWithinRoot() — GHSA-jvqc-qp6c-g58f
    safe-url.ts                 # assertHttpHttpsUrl() — GHSA-w846-hghr-xmrc
    __tests__/
      safe-path.test.ts
      safe-url.test.ts

  typescript/
    src/
      inspector/
        server.ts               # Express inspector server (NOT shipped on develop)
      utils/
        log.ts                  # Minimal logger shim (console.log/error)
    tools/src/
      edit-anthropic/
        str-replace-editor.ts   # Anthropic-style file editor CLI tool
      web-browser/
        index.ts                # Playwright browser automation CLI + HTTP server

  python/sweagent/inspector/
    server.py                   # Python equivalent of inspector server (patched)
```

## Key exports / surface

This package is `private: true` and has no `exports` field. Nothing in the monorepo imports it at runtime. The security helpers in `security/` are internal to the package.

- `security/safe-path.ts` — `resolvePathWithinRoot(rootDir, userPath): string`. Throws `Error("Invalid path")` on traversal, absolute paths outside root, or null-byte injection.
- `security/safe-url.ts` — `assertHttpHttpsUrl(url): URL`. Throws on non-http/https protocols (blocks `file://`, SSRF via metadata endpoints, etc.).

The TypeScript inspector server (`typescript/src/inspector/server.ts`) exports `startInspectorServer(options)`. It calls `resolvePathWithinRoot` on every `GET /api/trajectory/:filename` request to prevent path traversal.

The web-browser tool (`typescript/tools/src/web-browser/index.ts`) calls `assertHttpHttpsUrl` before every `page.goto()` call and disables the `executeScript()` method (throws on any call).

## Commands

```bash
bun run --cwd packages/sweagent test   # vitest run (security unit tests only)
```

## Config / env vars

| Var | Where used | Effect |
|-----|-----------|--------|
| `WEB_BROWSER_HEADLESS` | `web-browser/index.ts` | Set to `"0"` to run Chromium with a visible window (default headless) |

Inspector `port` and `trajectoryDir` are passed as CLI flags, not env vars. TypeScript server: `--port=`, `--dir=`. Python server: `--port`, `--directory`. The `host` option in `startInspectorServer()` defaults to `127.0.0.1` and is not exposed as a CLI flag or env var in the current CLI entry point.

## Security advisories

See `SECURITY.md` for full CVE details. Two advisories are addressed:

- **GHSA-jvqc-qp6c-g58f** — Inspector `GET /api/trajectory/:filename` path traversal. Fixed with `resolvePathWithinRoot()` in both TS and Python servers. Default bind changed to `127.0.0.1`.
- **GHSA-w846-hghr-xmrc** — Path traversal, SSRF/local file read via `web-browser`, command injection in `str-replace-editor`. Fixed with `assertHttpHttpsUrl()`, disabled `executeScript`, and safe path handling.

**The inspector HTTP server is not shipped in the develop build** — its removal is the effective mitigation for this repo. npm alpha releases still need a patched version.

## Conventions / gotchas

- The `typescript/tools/src/edit-anthropic/str-replace-editor.ts` imports `../registry` which is not present in this tree — that module resolves only in the upstream SWE-agent tool bundle. Do not run it in isolation without the registry shim.
- `typescript/src/utils/log.ts` is a stub (wraps `console.log/error`). It is not the elizaOS structured logger.
- The Python inspector server (`server.py`) and TypeScript inspector server (`server.ts`) are parallel ports of the same upstream SWE-agent inspector; they are not called by each other.
- Tests cover only `security/safe-path.ts` and `security/safe-url.ts`. The inspector and tool sources have no unit tests in this package.
- For architecture rules, naming conventions, and global logging standards, see the root `AGENTS.md`.
