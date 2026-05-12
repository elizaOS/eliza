# MSIX Packaging for Microsoft Store

## Overview

This directory builds MSIX packages for two distinct Windows distribution flavors,
selected via the `MILADY_BUILD_VARIANT` env var:

| Variant | Manifest | Sandbox | Local agents | Distribution |
|---------|----------|---------|---------------|--------------|
| `direct` (default) | `AppxManifest.xml` | Full-trust (`runFullTrust`) | Yes | NSIS / MSI / direct download |
| `store` | `AppxManifest.store.xml` | AppContainer | **No** (cloud only) | Microsoft Store |

The two manifests share the same `Identity Name` (`ElizaOS.App`), `Publisher`
(`CN=elizaOS`), and `Version` placeholder, so users see them as the same product.

## Files

| File | Purpose |
|------|---------|
| `AppxManifest.xml` | Direct-build manifest (full-trust desktop) |
| `AppxManifest.store.xml` | Store-build manifest (AppContainer-sandboxed) |
| `build-msix.ps1` | Build script — picks manifest by `MILADY_BUILD_VARIANT`, signs, verifies |
| `generate-placeholder-assets.ps1` | Creates placeholder visual assets |
| `assets/` | Tile / logo artwork |
| `store/` | Partner Center listing metadata + screenshots |

## Why two manifests

The original single manifest declared both `internetClient` AND `runFullTrust`,
which defeats AppContainer entirely — the app runs with full user privileges and
none of the store sandbox protections apply. Microsoft Store policy strongly prefers
sandboxed apps; full-trust packages require a `runFullTrust` restricted-capability
review and a higher bar for approval.

The split lets us keep full-trust behavior for users who download us directly
(local-agent operation requires it) while shipping a genuinely sandboxed flavor to
the Store.

## Capabilities chosen for the store build

`AppxManifest.store.xml` declares only what's required for cloud-mode operation:

- **`internetClient`** — outbound HTTPS to Eliza Cloud and model providers.
- **`internetClientServer`** — the renderer talks to the bundled local API process
  on a loopback port; loopback bind requires this capability under AppContainer.

Deliberately excluded:

- **`runFullTrust`** (restricted) — would void the sandbox; whole point of the
  store flavor is to live inside AppContainer.
- **`broadFileSystemAccess`** (restricted) — store users grant file access via the
  file-picker contract per file. No app-wide `%USERPROFILE%` access.
- **`privateNetworkClientServer`** — only add if a future store-build feature
  needs to talk to a LAN device (e.g. local Ollama on a different host). Not
  needed for cloud-only operation.

We do not declare `runFullTrust` even with the `rescap` namespace. If we ever
need it, the discussion is "do we ship a different product on the Store" — not
"add the capability and hope the review board misses it."

## Store-build runtime constraints

Code paths that require full-trust will fail under AppContainer. The store build
forces cloud hosting mode and gates these paths off via the sandbox-runtime layer
(parallel work in the Foundation agent track). Specific paths to verify on a real
Windows AppContainer host before Partner Center submission:

- **`plugins/plugin-agent-orchestrator/src/services/pty-init.ts`** —
  `resolveNodeWorkerPath()` walks `/opt/homebrew/bin/node`, `/usr/local/bin/node`,
  and `~/.nvm/versions/node/*/bin/node` looking for a Node binary. Under
  AppContainer, none of those paths are reachable, and `PATH`-lookup spawns of
  arbitrary binaries (`node`, `bun`, `codex`, `claude`) are blocked. The store
  build must never reach this code; gating belongs in the runtime-mode resolver.

- **`packages/app-core/scripts/desktop-build.mjs`** — uses `child_process.spawn`
  for build-time tooling (rcedit, vite, electrobun). This runs at build time on
  the developer/CI machine, not at runtime inside the package, so it is not an
  AppContainer concern.

- **Bun-runtime subprocess shell** — anything that spawns user-supplied commands
  (`runShell` chokepoint, `EXECUTE_CODE` action, coding-agent PTY adapters) must
  be disabled in store builds. The runtime-mode flag must hard-error these
  surfaces before they reach `Bun.spawn` / `child_process.spawn`.

- **Filesystem writes outside the package storage** — AppContainer redirects
  writes under `%USERPROFILE%` to per-app virtualized locations. Code that writes
  to `~/.milady/...` outside the runtime workspace must use either the package
  storage API or ask via file picker. The default state-dir resolution
  (`MILADY_STATE_DIR`) already points at the per-user app data path, so this
  largely works; verify `~/.milady/optimized-prompts` and
  `~/.milady/audit/app-loads.jsonl` writes succeed inside the package container.

This list is verification-only; the actual gating lives in the sandbox-runtime
agent's work. If you hit a failing path here, file it against that agent rather
than punching a hole in the manifest.

## Wire-up with desktop-build

`packages/app-core/scripts/desktop-build.mjs` produces the Electrobun bundle (the
input to MSIX) but does NOT build MSIX itself. MSIX is a separate Windows-only
step driven by `build-msix.ps1`. To produce a store MSIX:

```powershell
$env:MILADY_BUILD_VARIANT = "store"
pwsh -File packaging/msix/build-msix.ps1 `
  -BuildDir ./apps/app/electrobun/build `
  -OutputDir ./apps/app/electrobun/artifacts `
  -Version "2.0.0-beta.0"
```

The `MILADY_BUILD_VARIANT` env var is the same flag used by the runtime to gate
local-agent execution and force cloud hosting mode. Setting it for the build also
sets it for the packaged app's runtime via Electrobun's env propagation.

## Prerequisites

1. **Code signing**:
   - For `direct` builds: `WINDOWS_SIGN_CERT_BASE64` + `WINDOWS_SIGN_CERT_PASSWORD`,
     or Azure Trusted Signing.
   - For `store` builds: `MILADY_MSIX_STORE_CERT_PATH` (path to the `.pfx` issued
     by Partner Center for the registered Identity Name) +
     `MILADY_MSIX_STORE_CERT_PASSWORD`. If absent, the MSIX is delivered unsigned
     and Partner Center re-signs server-side on upload.
2. **Windows SDK** — installed on CI runner (available on `windows-latest`).
3. **Microsoft Partner Center account** — for Store submission ($19 one-time).

## Building locally

```powershell
# 1. Sign the executables first (direct flavor)
pwsh -File apps/app/electrobun/scripts/sign-windows.ps1 `
  -ArtifactsDir ./apps/app/electrobun/artifacts `
  -BuildDir ./apps/app/electrobun/build

# 2. Build MSIX (default: direct)
pwsh -File packaging/msix/build-msix.ps1 `
  -BuildDir ./apps/app/electrobun/build `
  -OutputDir ./apps/app/electrobun/artifacts `
  -Version "2.0.0-beta.0"

# 3. Build store MSIX
$env:MILADY_BUILD_VARIANT = "store"
pwsh -File packaging/msix/build-msix.ps1 `
  -BuildDir ./apps/app/electrobun/build `
  -OutputDir ./apps/app/electrobun/artifacts `
  -Version "2.0.0-beta.0"
```

Output filenames:
- `direct`: `ElizaOSApp-<version>-x64.msix`
- `store`: `ElizaOSApp-<version>-x64-store.msix`

## CI pipeline

`release-electrobun.yml` runs the direct flavor automatically when
`WINDOWS_SIGN_CERT_BASE64` is configured. The store flavor is opt-in: set
`MILADY_BUILD_VARIANT=store` on the CI step that targets Partner Center upload.

## Store submission

1. Create a Microsoft Partner Center account at https://partner.microsoft.com.
2. Register the app identity (`ElizaOS.App`).
3. **Set Identity env vars** on the CI step that produces the store MSIX
   (preferred over editing the manifest file in-tree):
   - `MILADY_MSIX_IDENTITY_NAME` — Partner Center-registered app name, e.g.
     `ElizaOS.App` (often the same as the placeholder, but Partner Center may
     issue a namespace-scoped name).
   - `MILADY_MSIX_PUBLISHER_ID` — full `Publisher` attribute, e.g.
     `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. MUST match the publisher ID
     issued for your Partner Center account.
   - `MILADY_MSIX_PUBLISHER_DISPLAY_NAME` — human-readable publisher, e.g.
     `elizaOS Labs`. Defaults to the placeholder `elizaOS` if unset.
   `build-msix.ps1` substitutes these into the staged manifest before
   `makeappx pack`. When unset, the script prints a `::warning::` and ships
   the placeholder values (Partner Center will reject the upload).
4. Replace placeholder assets in `assets/` with final artwork.
5. Add screenshots to `store/screenshots/`.
6. Build the store MSIX (`MILADY_BUILD_VARIANT=store` plus the three Identity
   env vars) and upload via Partner Center. Submit for certification review.

Example CI snippet:
```yaml
env:
  MILADY_BUILD_VARIANT: store
  MILADY_MSIX_IDENTITY_NAME: ElizaOS.App
  MILADY_MSIX_PUBLISHER_ID: CN=12345678-90AB-CDEF-1234-567890ABCDEF
  MILADY_MSIX_PUBLISHER_DISPLAY_NAME: elizaOS Labs
  MILADY_MSIX_STORE_CERT_PATH: ${{ secrets.MILADY_MSIX_STORE_CERT_PATH }}
  MILADY_MSIX_STORE_CERT_PASSWORD: ${{ secrets.MILADY_MSIX_STORE_CERT_PASSWORD }}
```

## Updating the publisher identity

After registering in Partner Center, update the `Publisher=` attribute in:
- `AppxManifest.xml`
- `AppxManifest.store.xml`
- `store/listing.json` → `identity.publisher`

The values must match exactly. A mismatch between the manifest's `Publisher` and
the certificate subject (or the Partner Center identity) is the most common
cause of a rejected submission.

## What to verify on a Windows host before submission

These cannot be verified from a non-Windows worktree; they are a checklist for
the Windows submission engineer:

- [ ] `xmllint --noout AppxManifest.store.xml` (or any XML validator) succeeds.
- [ ] `makeappx pack /d <staging> /p out.msix /o` succeeds against the store
      manifest.
- [ ] `signtool verify /pa /v out-store.msix` returns success when signed with
      `MILADY_MSIX_STORE_CERT_PATH`.
- [ ] App launches inside AppContainer (Task Manager → Details column "AppContainer
      = Yes" on the launcher process).
- [ ] Renderer reaches the local API on its loopback port without firewall prompt.
- [ ] Outbound HTTPS to Eliza Cloud succeeds.
- [ ] Cloud hosting mode is active; Settings → Hosting shows "Cloud (sandboxed)";
      attempting any local-agent action surfaces the gating error rather than
      silently failing.
- [ ] No write attempts hit `%USERPROFILE%` outside the per-app virtualized
      locations (use Process Monitor with the launcher process to confirm).
