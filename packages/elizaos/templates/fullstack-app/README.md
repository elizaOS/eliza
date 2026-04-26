# __APP_NAME__

A Milady-style fullstack app workspace built on [elizaOS](https://github.com/elizaos/eliza).

## Layout

- `apps/app` — the branded React + Capacitor + Electrobun shell
- `eliza` — upstream elizaOS source, managed as a git submodule
- `test` — thin test helpers that re-export the upstream app-core harness

## First Run

```bash
bun install
bun run dev
```

If the `eliza` submodule is missing, initialize it first:

```bash
git submodule update --init --remote eliza
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

- This template keeps the upstream elizaOS source local because several `@elizaos/*` workspace packages used by the app are not published on npm.
- The generated project is meant to be its own repo, with `eliza/` pinned independently through the submodule.
- The default brand kit is intentionally minimal. The source-of-truth files are `apps/app/public/favicon.svg` and `apps/app/public/splash-bg.svg`.
- `bun run --cwd apps/app brand:assets` regenerates the derived desktop assets: `public/splash-bg.png`, `electrobun/assets/appIcon.png`, `electrobun/assets/appIcon.ico`, and `electrobun/assets/appIcon.iconset/`.
- `apps/app/public/logos/*` is still required because `@elizaos/app-core` maps provider IDs to those fixed asset paths during onboarding and settings flows.
