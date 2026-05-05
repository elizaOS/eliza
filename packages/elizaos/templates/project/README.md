# __APP_NAME__

An elizaOS project built on [elizaOS](https://github.com/elizaos/eliza).

## Layout

- `apps/app` — the branded React + Capacitor + Electrobun app package
- `scripts` — source-mode helpers for package mode and optional local elizaOS
- `test` — local test helpers for the generated app

## First Run

```bash
bun install
bun run dev
```

The default install uses published `@elizaos/*` packages. To switch to an
in-repo elizaOS source checkout:

```bash
bun run setup:upstreams
```

## Common Commands

```bash
# Web / control UI
bun run dev

# Desktop shell
bun run dev:desktop

# App test suite
bun run test

# App package only
bun run --cwd apps/app build
```

## Notes

- Published package mode is the default. `bun run eliza:local` clones or reuses `./eliza`, installs it, and records local source mode in `.elizaos/source-mode`. `bun run eliza:packages` switches back to published packages.
- `./eliza` is ignored by git and is not a submodule. Use `ELIZA_GIT_URL` and `ELIZA_BRANCH` to choose a different checkout before running `bun run setup:upstreams`.
- The default brand kit is intentionally minimal. The source-of-truth files are `apps/app/public/favicon.svg` and `apps/app/public/splash-bg.svg`.
- `bun run --cwd apps/app brand:assets` regenerates the derived desktop assets: `public/splash-bg.jpg`, `electrobun/assets/appIcon.png`, `electrobun/assets/appIcon.ico`, and `electrobun/assets/appIcon.iconset/`.
- `apps/app/public/logos/*` is still required because `@elizaos/app-core` maps provider IDs to those fixed asset paths during onboarding and settings flows.
