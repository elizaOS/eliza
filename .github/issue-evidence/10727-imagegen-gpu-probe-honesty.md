# #10727 image-gen GPU probe honesty

PR: #11654
Scope: code-side selector fix only. This does not close the full local-model
lifecycle epic; it prevents the image-generation service from hardcoding
`gpu: undefined` after the hardware probe already proved CUDA/Metal.

## What changed

- `probeHardware().gpu.backend === "cuda"` now maps to the image-gen selector's
  `nvidia` vendor hint.
- `probeHardware().gpu.backend === "metal"` maps to `apple`, preserving the
  existing macOS Apple Silicon Metal path.
- `null` / unknown probe results stay `undefined`, so AMD/Intel remain on the
  current platform default until the probe can prove Vulkan support.
- Probe failures are logged and degrade to the platform default instead of
  being swallowed silently.

## Verification

Run in `/home/shaw/eliza-worktrees/pr-11654-gpu-probe-honesty` on 2026-07-02:

```bash
bun run --cwd plugins/plugin-local-inference test -- src/services/imagegen/backend-selector.test.ts src/services/hardware.test.ts
bun run --cwd plugins/plugin-local-inference typecheck
bun run --cwd plugins/plugin-local-inference lint:check src/services/imagegen/backend-selector.ts src/services/imagegen/backend-selector.test.ts src/services/imagegen/index.ts src/services/service.ts src/services/hardware.ts src/runtime/ensure-local-inference-handler.ts
git diff --check origin/develop...HEAD
```

Result:

- Selector and hardware focused tests: passed.
- Package typecheck: passed.
- Biome check: passed after import ordering was normalized.
- Whitespace check: passed.

## Evidence intentionally not claimed

- Real NVIDIA / Windows TensorRT image-generation run: N/A for this PR. The
  change is the deterministic service-to-selector mapping; #10727 remains open
  for the full publish -> download -> load -> run device matrix.
- AMD/Intel Vulkan proof: N/A for this PR. The existing probe still reports
  AMD/Intel as unknown at pre-load time, and this change deliberately avoids a
  false Vulkan claim.
- Screenshots/video: N/A. Runtime backend selection only, no UI surface.
