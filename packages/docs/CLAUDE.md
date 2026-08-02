# @elizaos/docs

Mintlify-hosted public documentation for elizaOS: the OS, runtime, app, Cloud, CLI, and reference material.

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
├── tracks/                     # Dimension-specific content tracks
│   ├── overview.mdx            # Dimension picker
│   ├── elizaos/                # OS track (Linux USB, AOSP, install)
│   ├── agent/                  # Runtime / agent track (create, character, lifecycle, memory)
│   ├── framework/              # @elizaos/core usage (actions, providers, evaluators, services)
│   ├── plugin/                 # Plugin authoring (create, anatomy, publish)
│   ├── cloud/                  # Eliza Cloud track
│   ├── agent-app/              # App layer track (desktop, mobile, dashboard)
│   ├── framework-app/          # Framework-app track
│   └── training/               # Eliza-1 and benchmark references
├── runtime/                    # Runtime internals reference
│   ├── core.mdx
│   ├── models.mdx
│   ├── memory.mdx
│   ├── events.mdx
│   ├── services.mdx
│   ├── providers.mdx
│   ├── types.md
├── apps/                       # App layer pages (desktop, mobile, dashboard, ui-library)
├── plugins/                    # Plugin reference pages
├── cli/                        # CLI reference (create-plugin, create-project, overview)
├── cloud/                      # Eliza Cloud reference (billing, auth, containers, agents, etc.)
├── guides/sandbox.mdx          # Public sandbox guide
├── development/                # Public development operations
├── user/                       # End-user guides (apps, providers, troubleshooting, etc.)
├── advanced/                   # Advanced topics (database, logs, trajectories)
├── dashboard/                  # Dashboard reference
├── skills/                     # Skills docs
├── security/                   # Public security and privacy documentation
├── test/
│   └── docs.test.js            # Test suite (nav integrity, broken links, empty files)
├── public/                     # Static assets (synced from packages/shared via predev/prebuild)
├── brand -> public/brand       # Mintlify local checker alias for /brand/* assets
├── images/                     # Images used in docs
├── logo/                       # Logo SVGs (light.svg, dark.svg)
└── style.css                   # Custom CSS overrides
```

## Commands

All scripts are in `packages/docs/package.json`.

```bash
# Run the test suite (nav integrity, page existence, broken links, empty files)
bun run --cwd packages/docs test
bun run --cwd packages/docs lint:check
bun run --cwd packages/docs format:check

# Preview locally with the current Mintlify CLI
bun run --cwd packages/docs predev
cd packages/docs && bunx mintlify@latest dev  # starts at http://localhost:3000

# Build (prebuild auto-syncs brand assets; actual build is handled by Mintlify CI)
# predev / prebuild both run: node ../shared/scripts/sync-to-public.mjs ./public --logos --favicons --ogembeds --banners
```

## Test suite

`test/docs.test.js` uses Node's built-in test runner (no external framework). It validates:

- `docs.json` exists, is valid JSON, and has required Mintlify fields (`name`, `colors`, `navigation`, `theme`).
- Navigation tabs and groups have no duplicate labels.
- No page is listed twice in the same group.
- All pages referenced in `docs.json` navigation have a matching `.md` or `.mdx` file on disk.
- All markdown files are non-empty and have structurally valid frontmatter.
- All internal links, local assets, repository source paths, and GitHub source links resolve.
- Documented Bun scripts and elizaOS Cloud API paths exist in their source-of-truth packages.
- Every content page is listed in navigation; hidden/internal documents do not live in this package.

Run with `bun run --cwd packages/docs test`.

## How to add or edit documentation

1. Create a `.mdx` (preferred) or `.md` file under the appropriate directory.
2. Add the page path (without extension) to the correct group in `docs.json` under `navigation.tabs`.
3. Verify with `bun run --cwd packages/docs test` — the test catches missing files and broken links.
4. From the repository root, run `bun run --cwd packages/docs predev`, then start `bunx mintlify@latest dev` inside `packages/docs`.

## Navigation structure (docs.json)

The `docs.json` file controls everything Mintlify renders: tabs, groups, page order, colors, fonts, logo, and navbar links. Each tab maps to a content area. Pages are listed by path relative to `packages/docs`, without extension.

Top-level tabs as of current content:
- **Get Started** — installation, quickstart, end-user guides, tracks overview, and project release links
- **OS** — elizaOS operating system (Linux, AOSP, install)
- **Runtime** — agent track, framework (`@elizaos/core`), plugins, and runtime internals
- **App** — app/desktop/mobile layer
- **Cloud** — Eliza Cloud managed APIs and services
- **CLI** — CLI reference (create-project, create-plugin, overview)
- **Reference** — configuration, deployment, advanced topics, security

## Brand asset sync

`predev` and `prebuild` both run `node ../shared/scripts/sync-to-public.mjs ./public` with flags `--logos --favicons --ogembeds --banners`. This copies brand assets from `packages/shared` into the `public/` directory so Mintlify can serve them. The tracked `brand` symlink points at `public/brand` so Mintlify's local validator can resolve `/brand/*` paths the same way the served site does. Do not hand-edit files under `public/brand/` — they are regenerated on every dev/build run.

## Conventions / gotchas

- This package has no TypeScript source. All content is `.md` / `.mdx`. Do not add a `src/` directory or TypeScript code here.
- `docs.json` navigation paths are case-sensitive and must exactly match file paths on disk.
- The test suite checks every internal link; broken links will fail CI. Always run tests after adding or renaming pages.
- Public content must appear in `docs.json`; internal engineering plans and compliance artifacts belong under the repository-root `docs/` tree.
- The `public/brand/` directory is auto-generated by the sync script (and committed). Edit brand asset source files in `packages/shared`, not here — local edits are overwritten on the next dev/build run.
- Mintlify uses the `$schema` in `docs.json` for validation; keep the schema URL intact.
- For architecture, naming, logging, and git workflow rules that apply across the entire repo, see the root `AGENTS.md`.

{/* BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) */}
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is repo-root `AGENTS.md`. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — docs / site:**
- The site built and the changed pages **rendered**, with before/after screenshots (desktop + mobile).
- Link/redirect checks that actually resolve, and any embedded examples that actually run.
- For redirects: the real HTTP redirect chain captured.
{/* END: evidence-and-e2e-mandate */}
