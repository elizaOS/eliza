# Issue #10724 — Local Inference Device Settings

## Scope

Documentation-only slice for the remaining #10724 device-specific recommendation deliverable.

The new `plugins/plugin-local-inference/README.md` section documents the current runtime policy from:

- `plugins/plugin-local-inference/src/services/device-tier.ts`
- `plugins/plugin-local-inference/src/services/recommendation.ts`
- `plugins/plugin-local-inference/src/runtime/embedding-presets.ts`
- `plugins/plugin-local-inference/scripts/local-inference-thresholds.json`

## Validation

- Reviewed the source constants and comments listed above.
- `git diff --check`

## N/A Evidence

- Tests: N/A — documentation-only, no runtime code changed.
- Screenshots/video: N/A — no UI changed.
- Real-LLM trajectories: N/A — no model, prompt, provider, action, or routing behavior changed.
- Device/battery capture: N/A — this PR documents the current policy; #11352 remains the hardware-gated issue for fresh on-device model/battery baselines.
