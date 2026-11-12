# Deployment Toolkit

This directory contains the generic deployment assets for elizaOS apps: Dockerfiles, compose files, node rollout scripts, Cloudflare proxy sources, and the cloud-agent runtime helpers.

This directory is part of `packages/app`. [`dstack/`](dstack/README.md)
holds the reproducible agent deployment for dstack CVMs.

Build from the repository root:

```bash
bun run --cwd packages/app build
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```
