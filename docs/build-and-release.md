# Build and release (CI, desktop binaries)

`.github/workflows/release-electrobun.yml` is the canonical desktop release workflow and reusable desktop release-build graph. `.github/workflows/test-electrobun-release.yml` calls that same graph on pull requests in build-only mode.

Post-release distribution is now centralized in `.github/workflows/release-orchestrator.yml`. Why: the repo ships multiple downstream channels (npm, PyPI, Snap, Debian/APT, Flatpak, Google Play, Apple stores, Homebrew, homepage), and letting each workflow independently listen to `release: published` made retries, compliance routing, and drift management harder than necessary. The orchestrator owns channel policy and fans out to reusable child workflows.

Why the release pipeline and desktop bundle work the way they do.

## macOS: why two DMGs (arm64 and x64)

We ship **separate** `Eliza-arm64.dmg` and `Eliza-x64.dmg` because:

- **Native Node addons** (e.g. `onnxruntime-node`, `whisper-node`) ship prebuilt `.node` binaries per OS and arch. There is no single "universal" npm artifact that contains both arm64 and x64; the addon is built for the arch of the machine that ran `npm install` / `bun install`.
- **CI builds both macOS architectures separately.** The Apple Silicon artifact runs on `macos-14`, and the Intel artifact runs on the dedicated `macos-15-intel` runner.
- **The Intel artifact still uses explicit x64 invocations** through the shared desktop builder (`ELIZA_DESKTOP_COMMAND_PREFIX="arch -x86_64"`) so native modules and helper binaries are resolved consistently as x64 throughout the packaging path.
- **Why this still matters on the Intel runner:** our workflow shares the same commands and staging logic across all jobs, and the explicit x64 path avoids accidental host/translation drift in the install and packaging steps.

See `.github/workflows/release-electrobun.yml`: the platform jobs run `arch -x86_64` for the macOS Intel leg during "Install root dependencies", `scripts/desktop-build.mjs stage`, and `scripts/desktop-build.mjs package`.

**Runner hygiene:** When GitHub **renames, updates, or retires** labels such as `macos-14` or `macos-15-intel`, update the matrix in `.github/workflows/release-electrobun.yml` (and any callers) and run **`.github/workflows/test-electrobun-release.yml`** on a branch to confirm the desktop build graph still passes before relying on it for a release.

## Desktop bundle: why we copy plugins and deps

The packaged app runs the agent from `eliza-dist/` (bundled JS + `node_modules`). The main bundle is built by tsdown with dependencies inlined where possible, but:

- **Plugins** (`@elizaos/plugin-*`) are loaded at runtime; their dist/ and any **runtime-only** dependencies (native addons, optional requires, etc.) must be present in `eliza-dist/node_modules`.
- **Why not rely on a single global node_modules at pack time?** The app is built into an ASAR (and unpacked dirs); resolution at runtime is from the app directory. So we copy the subset we need into `apps/app/electrobun/eliza-dist/node_modules` before packaging runs.

The packaging scripts derive that subset instead of keeping a hand-maintained allowlist:

1. `scripts/copy-runtime-node-modules.ts` handles the Electrobun build and scans the built `dist/` output for bare package imports, unions that with the installed `@elizaos/*` and `@elizaos/plugin-*` packages from the repo root, then recursively copies their runtime deps into `dist/node_modules`.
2. The packaging flow **walks package.json `dependencies` and `optionalDependencies` recursively**. **Why:** dynamic plugin loading and native optional deps change more often than the release workflow; deriving the closure from installed package metadata avoids shipping a stale allowlist.
3. Known dev/renderer-only packages (for example `typescript`, `lucide-react`) are skipped to keep the packaged runtime smaller.

We do **not** try to exclude deps that might already be inlined by tsdown into plugin dist/, because plugins can `require()` at runtime; excluding them would risk "Cannot find module" in the packaged app.

## Release workflow: design and WHYs

The release workflow (`.github/workflows/release-electrobun.yml`) is designed for **reproducible, fail-fast builds** and **diagnosable failures**. Key choices and their reasons:

- **Strict shell (`bash -euo pipefail`)** — Applied at job default for `build-desktop` so every step exits on first error, undefined variable, or pipe failure. **Why:** Without it, a failing command in the middle of a script can be ignored and the step still "succeeds", producing broken artifacts or confusing later failures.
- **Retry loops with final assertion** — `bun install` steps retry up to 3 times, then run the same install command once more after the loop. **Why:** If all retries failed, the loop exits without failing the step; the final run ensures the step fails with a clear install error instead of silently continuing.
- **Crash dump uses the maintained ASAR CLI** — When packaging crashes, we list ASAR contents with the maintained ASAR CLI, not the deprecated `asar` package. **Why:** The deprecated package can be missing or incompatible; the maintained ASAR tooling works when the build fails.
- **`find -print0` and `while IFS= read -r -d ''`** — Copying JS into `eliza-dist` and removing node-gyp artifacts use null-delimited find + read. **Why:** Filenames with newlines or spaces would break `find | while read`; null-delimited iteration is safe for any path.
- **DMG path via `find` + `stat -f`** — We pick the newest DMG with `find dist -name '*.dmg' -exec stat -f '%m\t%N' {} \; | sort -rn | head -1` instead of `ls -t dist/*.dmg`. **Why:** `ls -t` with a glob can fail or behave oddly when no DMG exists or paths have spaces; find + stat is robust and this step runs only on macOS where `stat -f` is available.
- **Remove node-gyp build artifacts before packaging** — We delete `build-tmp*` and `node_gyp_bins` under `node_modules` (root and eliza-dist). **Why:** @tensorflow/tfjs-node and other native addons leave symlinks to system Python there; the packager refuses to pack symlinks to paths outside the app (security), so the pack step would fail without removal.
- **Size report includes `eliza-dist`** — We report sizes of both `app.asar.unpacked/node_modules` and `app.asar.unpacked/eliza-dist` (and its node_modules when present). **Why:** Both regions contribute to artifact size; reporting both makes it obvious where bloat comes from.
- **Size report `du | sort | head` pipelines** — We run each pipeline in a subshell and capture exit code with `( pipeline ) || r=$?`, then allow 0 or 141; we also redirect `sort` stderr to `/dev/null`. **Why:** Under `bash -euo pipefail`, when `head` closes the pipe after N lines, `sort` gets SIGPIPE and exits 141; the step would exit before `r=$?` ran. The subshell + `||` lets us treat 141 as success. Silencing `sort` avoids noisy "Broken pipe" in logs.
- **Single Capacitor build step** — One "Build Capacitor app" step runs `npx vite build` on all platforms. **Why:** The previous split (non-Windows vs Windows) was redundant; vite build works everywhere, so one step reduces drift and confusion.
- **Packaged DMG E2E: 240s CDP timeout in CI, stdout/stderr dump on timeout** — In CI we use a longer CDP wait and on timeout we log app stdout/stderr before failing. **Why:** CI can be slower; a longer timeout reduces flaky failures. Dumping logs makes CDP timeouts debuggable instead of silent.

## Node.js and Bun in CI: WHYs

CI workflows that need Node (for node-gyp / native modules or npm registry) were timing out on Node download and install. We fixed this as follows.

- **`actions/setup-node@v4` on all runners** — Every workflow uses the standard `actions/setup-node@v4` on GitHub-hosted `ubuntu-24.04` / `windows-2025` runners.
- **`check-latest: false`** — We set this explicitly on every `actions/setup-node` step. **Why:** With the default, the action can hit nodejs.org to check for a newer patch; that adds latency and can timeout. We want a fixed, cached Node version for reproducible CI.
- **Bun global cache (`~/.bun/install/cache`)** — test.yml, release-electrobun.yml, benchmark-tests.yml, publish-npm.yml, and nightly.yml all cache this path with `actions/cache@v4` keyed by `bun.lock`. **Why:** Bun install is fast, but re-downloading every package every run was still a major cost; caching the global cache avoids re-downloading tarballs while letting `bun install` do its fast hardlink/clonefile into `node_modules`. We do not cache `node_modules` itself — compression/upload cost exceeds the gain.
- **`timeout-minutes` on jobs** — We set explicit timeouts (e.g. 20–30 min for test jobs, 45 for release build-desktop). **Why:** So a hung or extremely slow run fails in a bounded time instead of burning runner hours; also makes flakiness visible.

## Where this runs

- **Electrobun PR release validation:** `.github/workflows/test-electrobun-release.yml` — on pull requests; runs the same Electrobun release build matrix in build-only mode without creating a GitHub release.
- **Electrobun release:** `.github/workflows/release-electrobun.yml` — on version tag push or manual dispatch; builds macOS arm64, macOS x64, Windows x64, and Linux x64 Electrobun artifacts plus update channel files.
- **Pre-release gate and tag publication:** `.github/workflows/agent-release.yml` — validates the heavy build matrix, then creates the GitHub Release only after the blocking lanes are green.
- **Post-release distribution:** `.github/workflows/release-orchestrator.yml` — triggered by the published GitHub Release (or manual dispatch), computes stable vs pre-release channel policy, and fans out to the reusable publish workflows for npm, package registries, Android, Apple, Homebrew, and homepage deploy.
- **Local desktop build:** From repo root, use the Electrobun path: `bun run build:desktop` for a local bundle build, then `bash apps/app/electrobun/scripts/smoke-test.sh` for packaged desktop verification.

## Electrobun update-channel naming

Electrobun writes **platform-prefixed flat artifact names** into `apps/app/electrobun/artifacts/`, for example:

- `canary-macos-arm64-Eliza-canary.app.tar.zst`
- `canary-macos-arm64-Eliza-canary.dmg`
- `canary-macos-arm64-update.json`

Why the workflow mirrors that shape directly to `https://eliza.ai/releases/`:

- The Electrobun updater resolves manifests at `${baseUrl}/${platformPrefix}-update.json`, not `${baseUrl}/${channel}/update.json`.
- It also resolves tarballs at `${baseUrl}/${platformPrefix}-${tarballFileName}`.
- Because of that, the release upload step must publish `*-update.json`, `*.tar.zst`, and optional `*.patch` files at the **flat release root**. Uploading only a generic `update.json` or nesting files under version folders breaks in-app updates.

## CLI usage in this repo

The official Electrobun docs expect the CLI to come from the project dependency and be invoked through npm scripts or `bunx`. Eliza now uses the shared desktop builder to reach that package-local path:

- `apps/app/electrobun/package.json` declares `electrobun` as a dependency.
- `scripts/desktop-build.mjs stage` installs the Electrobun workspace package before packaging.
- `scripts/desktop-build.mjs package` drives `bun run build -- --env=...` inside `apps/app/electrobun`, and that script invokes `bunx electrobun build` against the package-local dependency.

We still keep two Windows-specific guards around that documented flow:

- **Pre-extract the Electrobun CLI tarball:** `electrobun@1.16.0` still shells out to plain `tar -xzf ...` on Windows. On GitHub runners that can resolve to GNU tar and fail on `C:` paths, so the workflow downloads the official `electrobun-cli-win-x64.tar.gz`, verifies its SHA256 from the GitHub release metadata, and extracts it with `C:\\Windows\\System32\\tar.exe` before the build runs.
- **Seed `rcedit` when needed:** the CLI still imports `rcedit` dynamically during Windows packaging, so the workflow copies a known-good `rcedit-x64.exe` from the already-installed workspace Bun packages into the Electrobun package before invoking `bun run build`. This avoids relying on a separate global registry fetch during release time.

## Windows preload EACCES recovery

`scripts/desktop-build.mjs` now runs a desktop preflight before preload bundling. It verifies:

- Bun version is a supported stable version.
- `apps/app/electrobun/node_modules/electrobun/package.json` contains `exports["./view"]`.
- Bun can resolve/import `electrobun/view` from `apps/app/electrobun`.

If preload build fails with `EACCES` around `electrobun/view`, use this exact repair flow:

1. Stop all Bun/Electrobun/Eliza processes.
2. Delete `apps/app/electrobun/node_modules`.
3. Delete root `node_modules/.bun`.
4. From repo root run `bun install --frozen-lockfile`.
5. Retry `bun run start:desktop`.

You can run the preflight alone with `bun run desktop:preflight`.

## Desktop WebGPU: browser + native

Eliza now carries both WebGPU paths in the desktop app:

- **Renderer-side WebGPU:** the existing avatar and vector-browser scenes run in the webview and prefer `three/webgpu` when the embedded browser exposes `navigator.gpu`.
- **Electrobun-native WebGPU:** `apps/app/electrobun/electrobun.config.ts` enables `bundleWGPU: true` on macOS, Windows, and Linux, so packaged desktop builds also include Dawn (`libwebgpu_dawn.*`) for Bun-side `GpuWindow`, `WGPUView`, and `<electrobun-wgpu>` surfaces.
- **Renderer choice for packaged builds:** macOS stays on the native renderer by default, while Windows and Linux default to bundled CEF. That matches Electrobun's current cross-platform guidance: Linux distribution should use CEF-backed `BrowserWindow`/`BrowserView` instances, and CEF gives us the most consistent browser-side WebGPU path on the non-macOS desktop targets.

Why this split exists:

- The current UI/React surfaces already live in the renderer webview, so browser WebGPU remains the lowest-risk path for those scenes.
- Bundling Dawn keeps the desktop runtime ready for native GPU surfaces and Bun-side compute/render workloads without maintaining a separate desktop flavor.

## Electrobun backend startup verification

The local Electrobun smoke test now verifies the backend, not just the window shell:

- After building, `apps/app/electrobun/scripts/smoke-test.sh` launches the packaged app and tails `~/.config/Eliza/eliza-startup.log`.
- It fails if the child runtime logs `Cannot find module`, exits before becoming healthy, or never reaches `Runtime started -- agent: ... port: ...`.
- Once the startup log reports a port, the script probes `http://127.0.0.1:${port}/api/health` and requires that endpoint to stay healthy for the liveness window.
- On Windows, `apps/app/electrobun/scripts/smoke-test-windows.ps1` now prefers the packaged `*.tar.zst` bundle and launches its `launcher.exe` directly. It only falls back to the `Eliza-Setup*.exe` installer path when no direct packaged bundle artifact is available.

Why: the previous smoke test could pass while the launcher stayed open but the embedded agent backend had already crashed.

## See also

- [Electrobun startup and exception handling](/electrobun-startup) — why the agent keeps the API server up on load failure.
- [Plugin resolution and NODE_PATH](/plugin-resolution-and-node-path) — why dynamic plugin imports need `NODE_PATH` in dev/CLI/Electrobun.
- [CHANGELOG](../CHANGELOG.md) — concrete changes and WHYs per release.
