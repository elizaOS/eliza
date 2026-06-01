# @elizaos/docs

Mintlify-hosted documentation for the elizaOS project — covers the OS, runtime, app layer, Cloud, Chip, and Robot tracks.

## Purpose / role

This package is a static documentation site, not a library. It has no exports and is not imported by any other package. It is consumed by the Mintlify platform, which serves it at the elizaOS public docs URL. The `private: true` flag in `package.json` enforces that it is never published to npm.

## Layout

```
packages/docs/
├── docs.json                   # Mintlify site config: nav tabs, colors, fonts, favicon, logo
├── index.mdx                   # Home page
├── quickstart.mdx              # Quickstart guide
├── installation.mdx            # Installation page
├── changelog.mdx               # Changelog
├── roadmap.md                  # Roadmap
├── tracks/                     # Dimension-specific content tracks
│   ├── overview.mdx            # Dimension picker
│   ├── elizaos/                # OS track (Linux USB, AOSP, install)
│   ├── agent/                  # Runtime / agent track (create, character, lifecycle, memory)
│   ├── framework/              # @elizaos/core usage (actions, providers, evaluators, services)
│   ├── plugin/                 # Plugin authoring (create, anatomy, publish)
│   ├── cloud/                  # Eliza Cloud track
│   ├── agent-app/              # App layer track (desktop, mobile, dashboard)
│   ├── framework-app/          # Framework-app track
│   ├── chip/                   # E1 RISC-V SoC track
│   └── training/               # Model training track
├── runtime/                    # Runtime internals reference
│   ├── core.mdx
│   ├── models.mdx
│   ├── memory.mdx
│   ├── events.mdx
│   ├── services.mdx
│   ├── providers.mdx
│   ├── types.md
│   └── action-callback-streaming.md
├── agents/                     # Agent internals reference
│   ├── character-interface.mdx
│   ├── memory-and-state.mdx
│   ├── personality-and-behavior.mdx
│   └── runtime-and-lifecycle.mdx
├── plugins/                    # Plugin reference pages
├── cli/                        # CLI reference (create-plugin, create-project, overview)
├── connectors/                 # Connector reference (Discord, Telegram, iMessage, etc.)
├── cloud/                      # Eliza Cloud reference (billing, auth, containers, agents, etc.)
├── guides/                     # How-to guides (contributing, custom actions, tutorials, etc.)
├── user/                       # End-user guides (apps, providers, troubleshooting, etc.)
├── advanced/                   # Advanced topics (database, logs, trajectories)
├── dashboard/                  # Dashboard reference
├── skills/                     # Skills docs
├── security/                   # Security docs (SOC2, threat model, key lifecycle, incidents)
├── launchdocs/                 # Desktop first-run documentation
├── stability/                  # Known failure modes
├── test/
│   └── docs.test.js            # Test suite (nav integrity, broken links, empty files)
├── public/                     # Static assets (synced from packages/shared via predev/prebuild)
├── images/                     # Images used in docs
├── logo/                       # Logo SVGs (light.svg, dark.svg)
└── style.css                   # Custom CSS overrides
```

## Commands

All scripts are in `packages/docs/package.json`.

```bash
# Run the test suite (nav integrity, page existence, broken links, empty files)
bun run --cwd packages/docs test

# Preview locally (install Mintlify CLI first: bun install -g mint)
# predev auto-syncs brand assets from packages/shared
mint dev     # run inside packages/docs; starts at http://localhost:3000

# Build (prebuild auto-syncs brand assets; actual build is handled by Mintlify CI)
# predev / prebuild both run: node ../shared/scripts/sync-to-public.mjs ./public --logos --favicons --ogembeds --banners
```

## Test suite

`test/docs.test.js` uses Node's built-in test runner (no external framework). It validates:

- `docs.json` exists, is valid JSON, and has required Mintlify fields (`name`, `colors`, `navigation`, `theme`).
- Navigation tabs and groups have no duplicate labels.
- No page is listed twice in the same group.
- All pages referenced in `docs.json` navigation have a matching `.md` or `.mdx` file on disk.
- All markdown files are non-empty.
- All internal links in markdown/MDX files resolve to real files.

Run with `bun run --cwd packages/docs test`.

## How to add or edit documentation

1. Create a `.mdx` (preferred) or `.md` file under the appropriate directory.
2. Add the page path (without extension) to the correct group in `docs.json` under `navigation.tabs`.
3. Verify with `bun run --cwd packages/docs test` — the test catches missing files and broken links.
4. Preview locally with `mint dev` from inside `packages/docs`.

## Navigation structure (docs.json)

The `docs.json` file controls everything Mintlify renders: tabs, groups, page order, colors, fonts, logo, and navbar links. Each tab maps to a content area. Pages are listed by path relative to `packages/docs`, without extension.

Top-level tabs as of current content:
- **Get Started** — installation, quickstart, tracks overview, changelog, roadmap
- **OS** — elizaOS operating system (Linux, AOSP, install)
- **Runtime** — agent track, framework (@elizaos/core), plugins, runtime internals, agent internals
- **App** — app/desktop/mobile layer
- **Cloud** — Eliza Cloud managed APIs and services
- **Chip** — E1 RISC-V SoC
- **Training** — model training

## Brand asset sync

`predev` and `prebuild` both run `node ../shared/scripts/sync-to-public.mjs ./public` with flags `--logos --favicons --ogembeds --banners`. This copies brand assets from `packages/shared` into the `public/` directory so Mintlify can serve them. Do not hand-edit files under `public/brand/` — they are regenerated on every dev/build run.

## Conventions / gotchas

- This package has no TypeScript source. All content is `.md` / `.mdx`. Do not add a `src/` directory or TypeScript code here.
- `docs.json` navigation paths are case-sensitive and must exactly match file paths on disk.
- The test suite checks every internal link; broken links will fail CI. Always run tests after adding or renaming pages.
- The `public/` directory is gitignored or auto-managed. Commit brand asset source files in `packages/shared`, not here.
- Mintlify uses the `$schema` in `docs.json` for validation; keep the schema URL intact.
- For architecture, naming, logging, and git workflow rules that apply across the entire repo, see the root `AGENTS.md`.
