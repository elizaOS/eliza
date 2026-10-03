# macOS entitlements

Mac App Store signing entitlements. Apply `mas.entitlements` to the outer app, `mas-child.entitlements` to nested binaries, and `mas-bun.entitlements` only to Bun. Preserve inside-out signing and the scoped JIT entitlement.

This directory is part of `packages/app/platforms/electrobun`.

Build from the repository root:

```bash
bun run --cwd packages/app/platforms/electrobun build
```

Test from the repository root:

```bash
bun run --cwd packages/app/platforms/electrobun test
```
