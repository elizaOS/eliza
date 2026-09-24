# elizaOS Boot Animation

`bootanimation.zip` lands at `/product/media/bootanimation.zip`; AOSP's `bootanimation` daemon plays it during the boot sequence (after the kernel logo, before the framework starts the launcher).

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
