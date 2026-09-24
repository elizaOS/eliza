# Flatpak packaging status

The canonical desktop release workflow packages the already-built and tested Electrobun Linux tree with `packages/app/scripts/package-electrobun-flatpak.mjs`.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run --cwd packages/app build
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```
