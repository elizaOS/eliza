# SWE-agent security advisories

Patched sources for `@elizaos/sweagent` / `@elizaos/sweagent-root` (`<= 2.0.0-alpha.31` on npm). The full `packages/sweagent` tree was **removed from `develop`**; this directory is for cherry-pick, npm release, or private-fork publication.

## GHSA-jvqc-qp6c-g58f — Inspector path traversal (High)

**Issue:** `GET /api/trajectory/:filename` used `path.join(trajectoryDir, filename)` without containment checks. Encoded `..%2F` sequences (decoded by Express) allowed arbitrary file read (`.env`, SSH keys, `/etc/passwd`).

**Fix (if inspector is re-enabled):**

| File | Mitigation |
|------|------------|
| `typescript/src/inspector/server.ts` | `resolvePathWithinRoot()` → HTTP 400; default bind `127.0.0.1` (not `0.0.0.0`) |
| `python/sweagent/inspector/server.py` | `_resolve_trajectory_file()` + HTTP 400; bind `127.0.0.1` |
| `security/safe-path.ts` | Shared containment helper (unit tested) |

**Monorepo consumers on `develop`:** the inspector HTTP server is **not shipped** — that removal is an effective mitigation for this repo. **npm alpha installs** still need a patched release or must not run the inspector on a network-facing host.

## GHSA-w846-hghr-xmrc — Multiple critical issues

Path traversal (same inspector paths), SSRF/local file read (`web-browser`), command injection (`str-replace-editor`). See table in prior advisory text; all four paths are patched here.

## Deployment

- Do not expose inspector or browser tool servers on `0.0.0.0` without authentication.
- Prefer `127.0.0.1` binding (now default in patched TS inspector).
- Set `ELIZA_SWEAGENT_INSPECTOR_HOST=0.0.0.0` only when you explicitly need LAN access and have network controls.
