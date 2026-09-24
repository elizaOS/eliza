# ElizaOS sepolicy

This directory contains the vendor SELinux policy included by `BOARD_VENDOR_SEPOLICY_DIRS += vendor/eliza/sepolicy` in `eliza_common.mk`.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
