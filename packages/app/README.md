<p align="center">
  <img src="public/android-chrome-192x192.png" alt="elizaOS" width="120" />
</p>

<h1 align="center">elizaOS</h1>

<p align="center">
  <em>Open-source AI agents for everyone</em>
</p>

<p align="center">
  <a href="https://github.com/elizaOS/eliza/actions/workflows/release.yml"><img src="https://github.com/elizaOS/eliza/actions/workflows/release.yml/badge.svg" alt="Build & Release" /></a>
  <a href="https://github.com/elizaOS/eliza/actions/workflows/test.yml"><img src="https://github.com/elizaOS/eliza/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="https://www.npmjs.com/package/@elizaos/app"><img src="https://img.shields.io/npm/v/@elizaos/app" alt="npm version" /></a>
  <a href="https://github.com/elizaOS/eliza/blob/main/LICENSE"><img src="https://img.shields.io/github/license/elizaOS/eliza" alt="License" /></a>
</p>

<p align="center">
  <a href="https://eliza.how">eliza.how</a>
</p>

---

A personal AI assistant you run on your own devices, built on [elizaOS](https://github.com/elizaos). Cross-platform — macOS, Windows, Linux, iOS, and Android.

## Install

### One-line install (recommended)

macOS / Linux / WSL:

```bash
curl -fsSL https://elizaOS.github.io/eliza/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://elizaOS.github.io/eliza/install.ps1 | iex
```

### npm global

```bash
npm install -g @elizaos/app
eliza setup
```

### no-install (optional)

```bash
bunx @elizaos/app setup
# or
npx @elizaos/app setup
```

### Download the App

Desktop and mobile builds are available on the [Releases](https://github.com/elizaOS/eliza/releases) page:

| Platform | Format |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.AppImage`, `.deb` |
| iOS | App Store (coming soon) |
| Android | Play Store (coming soon) |

## Quick Start

```bash
eliza onboard --install-daemon
eliza agent --message "hello" --thinking high
```

## Development

**Prerequisites:** Node.js >= 22, bun

### Setup

```bash
git clone https://github.com/elizaOS/eliza.git
cd eliza

bun install
bun run build
```

### Run the App (Desktop)

```bash
cd packages/app
bun install
bun run build:desktop
bun run dev:desktop
```

### Dev Server

```bash
cd packages/app
bun run dev
```

### Mobile

```bash
# iOS (requires macOS + Xcode 15+)
bun run ios

# Android (requires Android Studio + SDK 34+)
bun run android
```

### Build Plugins

```bash
bun run plugin:build
```

### Desktop app startup and errors

If the embedded agent fails to load (e.g. missing native module), the app keeps the API server up so the UI can show an error instead of "Failed to fetch". **Why:** Without that, one load failure would close the API server and the window would show only "Failed to fetch" with no message. See [Electrobun startup and exception handling](../../docs/electrobun-startup.md) for why the guards in `electrobun/src/native/agent.ts` exist and must not be removed.

### Plugin resolution

Dynamic plugin imports (`import("@elizaos/plugin-*")`) resolve from the importing file's location. In dev mode and CLI, that can miss root `node_modules`. We set `NODE_PATH` to repo root in `src/runtime/eliza.ts`, `scripts/run-node.mjs`, and `electrobun/src/native/agent.ts` (dev path). **Why:** Without this, dynamically loaded plugins fail with "Cannot find module" on boot. For Bun specifically, some published plugins have `exports["."].bun = "./src/index.ts"` (missing in the tarball); we patch those in `scripts/patch-deps.mjs` so Bun resolves via `dist/`. See [Plugin resolution and NODE_PATH](../../docs/plugin-resolution-and-node-path.md) (including "Bun and published package exports").

### Build and release (desktop bundle, CI)

Plugin and native deps for the packaged app are copied into `eliza-dist/node_modules` by the release packaging scripts (`scripts/copy-runtime-node-modules.ts` for Electrobun). They **derive** the runtime package closure from installed package metadata and the built server bundle instead of maintaining a manual allowlist. macOS Intel builds run install and build under Rosetta so x64 native binaries are included. **Why:** [Build and release (CI, desktop binaries)](../../docs/build-and-release.md) explains arch, copy script, and release workflow.

### Tests

```bash
# from repo root
bun run test
```

## License

MIT
