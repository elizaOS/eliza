# #10727 embedding hardware probe evidence

Date: 2026-07-01
Branch: `fix/mac-local-inference-tests`
Host: Apple M1 Pro MacBook Pro, macOS Darwin 25.4.0, arm64, 16 GB RAM.

## What changed

- Local embedding preset selection now consults the typed hardware probe when available.
- Detected `cuda`, `metal`, and `vulkan` backends select accelerated embedding presets (`gpuLayers: "auto"`) unless RAM is <= 8 GB.
- CPU fallback remains the default when no supported accelerator is detected or the probe fails.
- Agent/app-core embedding warmup now awaits the async config path before reading `LOCAL_EMBEDDING_*`.

## Real Mac hardware probe

Command:

```bash
bunx tsx -e "(async()=>{ const { probeHardware } = await import('./plugins/plugin-local-inference/src/services/hardware.ts'); const { selectEmbeddingPresetFromHardware, selectEmbeddingTierFromHardware } = await import('./plugins/plugin-local-inference/src/runtime/embedding-presets.ts'); const h=await probeHardware(); const tier=selectEmbeddingTierFromHardware(h); const preset=selectEmbeddingPresetFromHardware(h); console.log(JSON.stringify({platform:h.platform, arch:h.arch, appleSilicon:h.appleSilicon, totalRamGb:h.totalRamGb, freeRamGb:h.freeRamGb, gpu:h.gpu, tier, gpuLayers:preset.gpuLayers, label:preset.label}, null, 2)); })().catch((err)=>{ console.error(err); process.exit(1); })"
```

Observed output:

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "appleSilicon": true,
  "totalRamGb": 16,
  "freeRamGb": 0.6,
  "gpu": {
    "backend": "metal",
    "totalVramGb": 16,
    "freeVramGb": 0.6
  },
  "tier": "standard",
  "gpuLayers": "auto",
  "label": "Efficient (accelerated)"
}
```

Manual review: this confirms the landable #10727 bug is fixed on this Mac. Before the change, the sync fallback logic was Apple-Silicon-only and could not use the async probe; after the change, the real probe reports `metal`, and the selector returns the accelerated preset.

## Verification

Passed:

- `bun run install:light`
- `bun run --cwd packages/shared build:i18n`
- `bun run --cwd packages/contracts build`
- `bun run --cwd plugins/plugin-capacitor-bridge build`
- `bunx @biomejs/biome check plugins/plugin-local-inference/src/services/downloader.test.ts plugins/plugin-local-inference/src/runtime/embedding-presets.ts plugins/plugin-local-inference/src/runtime/embedding-presets.test.ts plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts plugins/plugin-local-inference/src/runtime/index.ts plugins/plugin-local-inference/src/index.ts packages/agent/src/runtime/eliza.ts packages/app-core/src/runtime/eliza.ts packages/app/vite/native-module-stub-plugin.ts`
- `NODE_OPTIONS='--experimental-sqlite' bunx vitest run plugins/plugin-local-inference/src/runtime/embedding-presets.test.ts plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.test.ts`
  - Result: 2 files passed, 28 tests passed.
- `bun run --cwd plugins/plugin-local-inference typecheck`
- `git diff --check`

Blocked / unrelated current-tree failure:

- `bun run verify` fails before the package lanes at `audit:type-safety-ratchet`: `as unknown as` is 109/77 and `?? 0` is 384/380 in unrelated tracked production files.

## Evidence Applicability

- Screenshots/video: N/A. This is a server/runtime config selection change with no UI surface.
- Real-LLM trajectory: N/A. This does not change prompts, actions, model text generation, or agent behavior selection.
- Full device lifecycle proof: not claimed here. Real CUDA/Vulkan/Metal embedding load + tokens/sec evidence remains part of the broader #10727 matrix.
