# 10727 local embedding accelerator preset evidence

Date: 2026-07-01
Branch: `codex/fix/10727-local-embedding-accelerator`
PR: https://github.com/elizaOS/eliza/pull/10814

## What changed

The local embedding preset detector no longer treats every non-Apple-Silicon
host as CPU-only. It now keeps CPU fallback for low-RAM or CPU-only machines,
selects the accelerated `gpuLayers: "auto"` preset for Metal/CUDA/Vulkan-capable
profiles, and exposes a hardware-profile helper for async probe consumers.

## Commands run

```bash
bun run --cwd plugins/plugin-local-inference lint:check
# PASS - Checked 426 files. No fixes applied.

bun run --cwd plugins/plugin-local-inference typecheck
# PASS - tsgo --noEmit

bunx vitest run plugins/plugin-local-inference/src/runtime/embedding-presets.test.ts
# PASS - 1 file, 6 tests
```

Before the final rebase, the full plugin suite passed:

```bash
bun run --cwd plugins/plugin-local-inference test
# PASS - 220 test files passed, 1 skipped
# PASS - 2200 tests passed, 14 skipped
```

After the final rebase, a full plugin-suite rerun hit four timeout failures under
machine contention in unrelated tests:

- `__tests__/freeze-voice-cli.test.ts`
- `__tests__/imagegen-sd-cpp-probe.test.ts`
- `src/local-inference-routes.test.ts`
- `src/services/ffi-unload-ordering.test.ts`

Those exact files passed in isolation:

```bash
bunx vitest run --root plugins/plugin-local-inference \
  __tests__/freeze-voice-cli.test.ts \
  __tests__/imagegen-sd-cpp-probe.test.ts \
  src/local-inference-routes.test.ts \
  src/services/ffi-unload-ordering.test.ts
# PASS - 4 files, 33 tests
```

Repo-level verify was attempted and stopped before package checks on unrelated
type-safety ratchet baseline drift:

```bash
bun run verify
# FAIL in audit:type-safety-ratchet
# as unknown as: 109 current > 77 baseline
# ?? 0 (core/agent/app-core): 384 current > 380 baseline
```

## N/A evidence

- UI screenshots/video: N/A - no UI surface changed.
- Real LLM trajectory: N/A - no prompt, action, provider, or model trajectory changed.
- On-device model lifecycle matrix: not captured here. This PR fixes the concrete
  CPU-default preset bug called out in #10727; the full model/device matrix still
  requires the target hardware fleet.
