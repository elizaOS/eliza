# @elizaos/sweagent-root

Security-patched vendor sources for [SWE-agent](https://github.com/SWE-agent/SWE-agent).

## What this is

This package holds security-remediated copies of upstream SWE-agent Python and TypeScript sources. It is **not a published elizaOS plugin** and not imported at runtime by the rest of the elizaOS monorepo. It exists so that:

- Security fixes (path traversal, SSRF) are tracked, tested, and cherry-pick-ready.
- Patched releases can be cut to npm without the full upstream build graph.
- Private forks can apply these patches with confidence.

## Security advisories addressed

| Advisory | Severity | Issue | Fix |
|----------|----------|-------|-----|
| GHSA-jvqc-qp6c-g58f | High | Inspector `GET /api/trajectory/:filename` path traversal | `resolvePathWithinRoot()` + 127.0.0.1 default bind |
| GHSA-w846-hghr-xmrc | Critical | Path traversal, SSRF via web-browser, command injection in str-replace-editor | `assertHttpHttpsUrl()`, disabled `executeScript`, safe path handling |

See `SECURITY.md` for full details and deployment guidance.

## Package layout

```
security/           Shared safe-path and safe-url helpers (unit tested)
typescript/         TypeScript inspector server + SWE-agent tool ports
python/             Python inspector server port
```

## Running the tests

```bash
bun run --cwd packages/sweagent test
```

This runs only the security unit tests (`security/__tests__/`).

## Deployment notes

- Do not expose the inspector or browser tool servers on `0.0.0.0` without authentication.
- The inspector HTTP server is **not shipped** in the elizaOS `develop` build — its absence is itself a mitigation.
- Set `ELIZA_SWEAGENT_INSPECTOR_HOST=0.0.0.0` only when you explicitly need LAN access and have network controls in place.
- The TypeScript web-browser tool requires Playwright (`chromium`) to be installed separately.
