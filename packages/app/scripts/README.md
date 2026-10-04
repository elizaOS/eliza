# `scripts/` — build, dev orchestration, tooling

Build, development, packaging, and platform orchestration for the Eliza app. Invoke scripts through the root or app package manifests.

This directory is part of `packages/app`.

Build from the repository root:

```bash
bun run build:client
```

Test from the repository root:

```bash
bun run --cwd packages/app test
```

Hosted Android E2E requires SELinux enforcing and never roots the device or relaxes
its policy. The runner requires the renderer stamp to match the full current Git
revision, rebuilding cached output from older revisions before testing.

Thin consumers can build the shared task runtime with `build:consumer-tasks --
OUTPUT SOURCE_ROOT REVIEWED_COMMIT`. The builder exports immutable Git bytes,
records the full source commit and bundle hash, and optionally stages the narrow
browser task/voice contracts through its `browserSource` API option. Product
policy and task workflows are supplied by the consuming host.
