# Confidential image repro-build context (OS-5)

Status: **BLOCKED on a build host.** meta-dstack is **not vendored** here yet and there is no Yocto/bitbake toolchain or TDX build host in this environment, so the multi-hour reproducible image build cannot run locally.

This directory is part of `packages/os`.

Build from the repository root:

```bash
bun run --cwd packages/os build
```

Test from the repository root:

```bash
bun run --cwd packages/os test
```
