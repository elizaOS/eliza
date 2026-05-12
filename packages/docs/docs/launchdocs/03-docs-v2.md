# Launch Readiness 03: Docs V2

## Second-Pass Status (2026-05-05)

- Superseded: the root README Node-version finding is fixed; it now says Node v24+.
- Still open: public docs still contain Node 22+ requirements, stale `@elizaos/app` CLI instructions, missing desktop scripts/spec references, and `elizaos deploy` commands that do not exist in the current CLI.
- Launch gate: `node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json` now validates launchdocs links and documented `bun run` commands, but the broader docs tree still fails and needs a separate cleanup pass.

Worker: 03
Date: 2026-05-04
Repo: `/Users/shawwalters/eliza-workspace/eliza/eliza`
Write target: `launchdocs/03-docs-v2.md`

## Current state

Docs are not v2-launch ready as a public, coherent user path. The strongest docs are the repo-root README and many English runtime/API pages, but the launch surface is split across incompatible product stories:

- Root README presents `elizaos` as the template/scaffold CLI and is mostly aligned with the actual `packages/elizaos` command set.
- User docs present `eliza` as the runtime CLI and include many pages for start/setup/plugins/models/dashboard/update.
- Package/app docs present `@elizaos/app` as an installable CLI app with commands that are not present in current package metadata.
- Cloud docs describe `elizaos deploy` and AWS ECS deployment flows, but the current `elizaos` CLI has no `deploy` command.
- Mobile/desktop setup docs reference paths and scripts from an older layout, especially `apps/app` and `apps/app/electrobun`, while the current repo uses `packages/app` and `packages/app-core/platforms/electrobun`.
- Public identity is inconsistent: `docs.elizaos.ai`, `docs.eliza.ai`, `eliza-ai/eliza`, `elizaOS/eliza`, `elizaos/eliza`, `@elizaai/app`, and `@elizaos/app` all appear in launch-facing docs.

I would not ship these docs as-is for a v2 launch. Users following the install, desktop, mobile, or cloud paths can hit wrong package names, missing commands, wrong repo links, or non-existent local paths.

## Evidence reviewed with file refs

Primary docs and config:

- `README.md:12` links official docs to `https://docs.elizaos.ai/`, while runtime CLI help printed `Docs: https://docs.eliza.ai/cli`.
- `README.md:71` says Node.js v23+, while root `package.json:6-8` pins Node `24.15.0` and `packages/elizaos/package.json:58-60` requires `>=24.0.0`.
- `README.md:73-80`, `README.md:82-84`, `README.md:109-113`, and `README.md:134-138` describe `elizaos create/info/upgrade` scaffolding flows.
- `packages/elizaos/src/cli.ts:41-73` confirms the `elizaos` CLI commands are only `version`, `info`, `create`, and `upgrade`.
- `packages/elizaos/package.json:2-8` confirms package name/bin is `elizaos`.
- `package.json:18-24` confirms root scripts for `start`, `start:eliza`, `dev`, `dev:desktop`, and `dev:desktop:watch`.
- `package.json:66-76` confirms cloud helper scripts proxy into `cloud`.
- `docs/docs.json:19-20` points navbar GitHub at `https://github.com/eliza-ai/eliza`, while `git remote -v` shows primary remotes under `https://github.com/elizaOS/eliza.git`.

Install and package docs:

- `docs/installation.mdx:13-15` says Node.js `>= 22`, inconsistent with Node 24 requirements in package metadata.
- `docs/installation.mdx:19`, `docs/installation.mdx:89-94` use `eliza-ai/eliza`, `elizaai`, Homebrew tap `eliza-ai/eliza`, Snap, and Flatpak install surfaces that I did not validate as current.
- `packages/app/README.md:45-55` says `npm install -g @elizaos/app`, `bunx @elizaos/app setup`, and `npx @elizaos/app setup`, but `packages/app/package.json:1-28` has no `bin` field.
- `packages/app/README.md:72-74` documents `eliza onboard --install-daemon` and `eliza agent --message`, but current `eliza` CLI help did not list `onboard` or `agent`.
- `packages/app/README.md:79` says Node.js `>= 22`, inconsistent with Node 24 requirements.
- `packages/app/README.md:93-98` says run desktop from `packages/app` using `build:desktop` and `dev:desktop`; `packages/app/package.json:5-28` has no matching scripts.

Mobile and desktop docs:

- `docs/apps/mobile.md:16-18` lists package name `@elizaai/app` and version `2.0.0-alpha.87`; current `packages/app/package.json:2-3` is `@elizaos/app` at `2.0.0-alpha.87`.
- `docs/apps/mobile.md:39` says Node.js 22+.
- `docs/apps/mobile.md:44-54` says mobile build commands run from repo root, but root `package.json:9-76` has no `build:ios`, `build:android`, `cap:open:ios`, or `cap:open:android`; these are in `packages/app/package.json:18-26`.
- `docs/apps/mobile.md:58` and `docs/apps/mobile.md:72` point native projects at `packages/app/ios` and `packages/app/android`; those paths exist.
- `docs/apps/mobile/build-guide.md:7-9` says the app lives in `apps/app` and commands run from `apps/app`; current source is `packages/app`.
- `docs/apps/mobile/build-guide.md:69-104` uses `dev:ios:*` scripts; I did not find those in root or `packages/app/package.json`.
- `docs/apps/desktop-local-development.md:75`, `docs/apps/desktop-local-development.md:83-91`, and `docs/apps/desktop-local-development.md:203-204` reference `packages/app/electrobun`, but the actual Electrobun package is `packages/app-core/platforms/electrobun`.
- `packages/app-core/platforms/electrobun/package.json:2-14` confirms actual package name and scripts including `build:native-effects`.
- `packages/app-core/platforms/electrobun/README.md:21-23` says `cd apps/app/electrobun`, which is stale.
- `docs/apps/desktop-local-development.md:152-156` documents a `desktop:stack-status` script; I found `packages/app-core/scripts/desktop-stack-status.mjs`, but no matching root script.
- `docs/apps/desktop-local-development.md:182-184` links two missing Playwright specs. `packages/app/test/ui-smoke/ui-smoke.spec.ts` exists; `settings-chat-companion.spec.ts` and `packaged-hash.spec.ts` do not.

Cloud/homepage docs:

- `cloud/README.md:31`, `cloud/README.md:91-93`, `cloud/README.md:861-890`, and `cloud/README.md:1854-1943` repeatedly document `elizaos deploy`, but the current `elizaos` CLI has no `deploy` command.
- `cloud/README.md:321-328` lists dependency versions such as AI SDK 5.0.60 and `@elizaos/core 1.6.1`; current `cloud/package.json` uses AI SDK 6.x packages and `@elizaos/core` set to `alpha`.
- `cloud/package.json:15-31` confirms current cloud dev/build scripts are Bun workspace commands, while `cloud/README.md:1915-1916` still says `npm run dev` and `npm run build && npm start`.
- `packages/homepage/README.md:39-48` matches `packages/homepage/package.json` scripts for `dev`, `build`, and `preview`.
- `packages/homepage/README.md:60` uses `bun run --filter eliza-app build`; package name is `eliza-app`, so this is plausible, but I did not run a Cloudflare Pages build.

Package READMEs:

- `packages/docs/README.md:19-35` says Node v23+ and `mint dev`; current repo package metadata requires Node 24 and the docs site lives under root `docs/`, not clearly under `packages/docs`.
- `packages/docs/README.md:105` links `https://github.com/elizaos/elizaos`, likely stale relative to current remotes.
- `packages/app-core/platforms/electrobun/README.md:38` uses a relative link that resolves under `packages/app-core/platforms/docs`, not root `docs`.
- `packages/skills/README.md:15-17` includes both npm and bun installs. That may be acceptable for library consumers, but it should be separated from monorepo contributor guidance because the repo is Bun-managed.

## What is outdated/missing

- A single canonical launch path is missing. Users see `elizaos` for scaffolding, `eliza` for runtime, `@elizaos/app` for app install, and `@elizaai/app` in app docs.
- Public install docs need a hard source-of-truth pass. The repo currently advertises `get.eliza.ai`, `elizaOS.github.io`, npm package `elizaai`, npm package `@elizaos/app`, Homebrew, Snap, Flatpak, App Store, Google Play, GitHub Releases, and CLI scaffolding. Several of these are not validated by local package metadata.
- Node version guidance is stale. Launch docs say Node 22+ or 23+ in multiple places, while package metadata requires Node 24.
- Cloud deployment docs are stale or ahead of implementation. `elizaos deploy` is documented extensively but unavailable in the current CLI.
- Desktop path docs are stale after moving Electrobun to `packages/app-core/platforms/electrobun`.
- Mobile docs mix root and package-local command locations. The command scripts exist under `packages/app`, not root, except through possible helper scripts that are not present in root `package.json`.
- Docs navigation includes missing pages: `plugin-registry/acp`, `connectors/acp`, and `plugin-registry/platform/acp`.
- Localized docs appear less maintained than English docs. The local link checker found many stale `/es`, `/fr`, and `/zh` links, especially changelog links into pages that do not exist in those locales.
- A launch-oriented docs structure is missing. Current docs mix product user docs, framework docs, app setup docs, historical plans, PRDs, internal implementation notes, and generated registry docs in one navigation.

## What I could validate

- `elizaos` CLI command surface. Running local CLI help showed only `version`, `info`, `create`, and `upgrade`, matching `packages/elizaos/src/cli.ts`.
- `eliza` runtime CLI command surface. Running local app-core entry help showed `start`, `run`, `benchmark`, `setup`, `doctor`, `db`, `configure`, `config`, `dashboard`, `update`, `auth`, `plugins`, and `models`. It did not show `deploy`, `onboard`, or `agent`.
- Node/package versions from local package metadata:
  - root `package.json` version `2.0.0-alpha.176`, Node `24.15.0`
  - workspace packages like `@elizaos/core`, `@elizaos/agent`, `@elizaos/app-core`, and `elizaos` at `2.0.0-alpha.537`
  - `@elizaos/app` at `2.0.0-alpha.87`
- Current key repo paths:
  - `packages/app` exists
  - `packages/app/ios` exists
  - `packages/app/android` exists
  - `packages/app-core/platforms/electrobun` exists
  - `apps/app` is missing
  - `packages/app/electrobun` is missing
- Docs navigation file existence:
  - 319 unique docs.json page refs checked
  - 3 missing nav page refs: `plugin-registry/acp`, `connectors/acp`, `plugin-registry/platform/acp`
- Local link checks:
  - Full docs/package README pass: 766 Markdown/MDX/README files, 2016 local links, 538 broken local links.
  - English-focused pass: 359 files, 1126 local links, 61 broken local links.
  - Biggest English broken-link sources were `cloud/README.md` with 23, two historical plan docs with 21 combined, `docs/guides/onboarding-ui-flow.md` with 7, and `docs/apps/desktop-local-development.md` with 4.
- Homepage README command names match `packages/homepage/package.json` for `dev`, `build`, and `preview`.

## What I could not validate

- External release/download availability:
  - `https://get.eliza.ai`
  - `https://docs.eliza.ai`
  - `https://docs.elizaos.ai`
  - `https://github.com/eliza-ai/eliza/releases/latest`
  - `https://github.com/elizaOS/eliza/releases/latest`
  - Homebrew, Snap, Flatpak, App Store, Google Play, and npm package install behavior
- Whether `elizaos deploy` exists in a separate unreleased/private CLI package. It is not present in this repo's `packages/elizaos`.
- Whether mobile `dev:ios:*` helpers are generated dynamically or exist in another branch. I did not find them in current root or `packages/app` package scripts.
- Full Mintlify build. I probed `bunx mint --version`; it downloaded transient dependencies and returned `unknown`. I did not run a docs build because this would not be a clean, bounded validation step in the current workspace.
- Full command execution for heavy scripts such as mobile builds, desktop packaging, cloud builds, and root tests.
- External link status and redirects. I only performed local filesystem/path checks.

## Bugs/risks P0-P3

### P0

None found in docs alone.

### P1

- Public install docs can route users to wrong package names and missing commands. `packages/app/README.md:45-55` advertises `@elizaos/app` as a global/no-install CLI package, but `packages/app/package.json` has no bin. `packages/app/README.md:72-74` advertises `eliza onboard` and `eliza agent`, but local `eliza` help does not include them.
- Cloud deployment docs advertise a non-existent `elizaos deploy` command. This appears in `cloud/README.md:31`, `cloud/README.md:91-93`, `cloud/README.md:861-890`, and `cloud/README.md:1854-1943`; current `packages/elizaos/src/cli.ts:41-73` has no deploy command.
- Node version requirements are inconsistent. Docs say Node 22+ or 23+ (`docs/installation.mdx:13-15`, `README.md:71`, `packages/app/README.md:79`), while package metadata requires Node 24 (`package.json:6-8`, `packages/elizaos/package.json:58-60`).
- Desktop docs point to missing Electrobun paths and commands. `docs/apps/desktop-local-development.md:83-91` and `packages/app-core/platforms/electrobun/README.md:21-23` point at `packages/app/electrobun` or `apps/app/electrobun`; current package is `packages/app-core/platforms/electrobun`.

### P2

- Docs domain and repo identity are inconsistent. `README.md:12` and `README.md:67` use `docs.elizaos.ai`; local runtime help uses `docs.eliza.ai/cli`; `docs/docs.json:19-20` points GitHub to `eliza-ai/eliza`; git remotes use `elizaOS/eliza`.
- Mobile setup docs use stale package identity and command locations. `docs/apps/mobile.md:16-18` uses `@elizaai/app`; `docs/apps/mobile/build-guide.md:7-9` uses `apps/app`; scripts actually live in `packages/app/package.json:18-26`.
- Docs navigation has missing pages: `plugin-registry/acp`, `connectors/acp`, `plugin-registry/platform/acp`.
- Local link health is not launch-grade. English docs still have 61 broken local links; full docs/package README pass has 538, mostly from localized docs and stale cloud docs.
- Cloud README has stale dependency versions and many broken local links. For example, `cloud/README.md:321-328` mentions old AI SDK and `@elizaos/core` versions.

### P3

- Root README monorepo command comment says `bun run dev` is "API + Vite UI for apps/app" (`README.md:180`), but the current app source is `packages/app`.
- `packages/docs/README.md` describes a docs package layout that does not match the root `docs/` tree and links to `elizaos/elizaos`.
- Historical plans and PRDs are included under `docs/` with many absolute local machine paths and stale source links. They are useful internally but should not be first-class launch navigation content.
- Package READMEs mix consumer install instructions and monorepo contributor instructions. That is confusing for packages that are private, workspace-only, or not directly executable.

## Low-risk doc fixes Codex can do

- Replace Node version guidance with a single source of truth: Node 24+ or exact `24.15.0`, depending on product decision.
- Update local paths from `apps/app` and `packages/app/electrobun` to `packages/app` and `packages/app-core/platforms/electrobun` where clearly mechanical.
- Remove or quarantine broken docs.json pages for ACP until pages exist.
- Fix package/app README so it no longer advertises `@elizaos/app` as a CLI package unless a bin is added.
- Replace `eliza onboard` and `eliza agent` quick-start commands with current `eliza setup`, `eliza start`, `eliza dashboard`, or a product-approved first-run flow.
- Fix `docs/apps/desktop-local-development.md` references for `desktop-stack-status`, Playwright specs, and release checklist links.
- Move cloud `elizaos deploy` sections behind an "internal/proposed" label, or replace them with current `cloud/package.json` commands.
- Update cloud dependency version bullets from package metadata or remove exact versions from prose.
- Normalize package names from `@elizaai/app` to `@elizaos/app` where current package metadata is authoritative.
- Add a lightweight local link check script for docs and run it in CI against English launch docs first.

## Human/product decisions needed

- Canonical public brand and repo:
  - Is the public repo `elizaOS/eliza`, `elizaos/eliza`, or `eliza-ai/eliza`?
  - Is the docs domain `docs.eliza.ai` or `docs.elizaos.ai`?
  - Is the product name "Eliza", "elizaOS", or both with separate meanings?
- Canonical install path:
  - Should users install `eliza`, `elizaos`, `elizaai`, `@elizaos/app`, a desktop app, or a hosted cloud app?
  - Which channels are real for launch: GitHub Releases, npm, curl installer, Homebrew, Snap, Flatpak, App Store, Google Play?
- CLI split:
  - Should `elizaos` remain only scaffold/upgrade, while `eliza` owns runtime/setup/plugins/models?
  - If yes, docs need an explicit "two CLIs" page.
  - If no, decide which commands should move or be aliased.
- Cloud deployment:
  - Is `elizaos deploy` a launch feature?
  - If yes, the CLI implementation is missing from this repo.
  - If no, cloud README needs to stop advertising it as available.
- Mobile launch scope:
  - Are iOS and Android user downloads available at launch or "coming soon"?
  - Is on-device agent / cloud-hybrid a launch feature or internal development mode?
- Docs audience split:
  - Should `docs/` be public product docs, framework developer docs, internal engineering docs, or all three with explicit visibility?
- Localization:
  - Should localized docs be launch-gated, hidden until refreshed, or allowed to lag English?

## Recommended docs structure

Recommended public v2 structure:

1. Start
   - What is Eliza / elizaOS
   - Choose your path: desktop app, CLI runtime, scaffold an app, use framework package, cloud
   - Install
   - First launch
   - Troubleshooting

2. Use Eliza
   - Runtime modes: local, LAN, remote, Eliza Cloud
   - Providers and models
   - Character and memory
   - Apps/control surfaces
   - Connectors
   - Skills/plugins as user capabilities

3. Build with elizaOS
   - Framework overview
   - `@elizaos/core`, `@elizaos/agent`, `@elizaos/app-core`
   - `elizaos` scaffold CLI
   - Templates
   - Plugins
   - Runtime services/events/memory
   - REST/WebSocket API

4. App Development
   - `packages/app` web shell
   - Desktop Electrobun: `packages/app-core/platforms/electrobun`
   - Mobile Capacitor: `packages/app`, `packages/app/ios`, `packages/app/android`
   - Build/release/checklists

5. Cloud
   - User-facing cloud setup
   - Cloud API/auth/billing
   - Cloud local development
   - Deployment only if command exists and is launch-supported

6. Reference
   - CLI reference: split `eliza` and `elizaos`
   - Config schema
   - REST reference
   - Plugin registry
   - Troubleshooting matrix

7. Internal/Archive
   - PRDs
   - plans
   - proposals
   - rollout notes
   - old changelogs
   - retired patches

## Changed paths

- `launchdocs/03-docs-v2.md`
