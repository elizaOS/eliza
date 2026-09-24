# TurboQuant / QJL / PolarQuant KV cache kernels (Vulkan + Metal)

Native inference kernels, model converters, and backend verification tools.

Preserve packed tensor layouts and the public ABI. Compare kernels with scalar references and exercise the built runtime graph on the claimed physical backend before declaring it supported.

This directory is part of `plugins/plugin-local-inference`.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-local-inference build
```

Test from the repository root:

```bash
bun run --cwd plugins/plugin-local-inference test
```
