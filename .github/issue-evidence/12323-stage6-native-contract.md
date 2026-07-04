# #12323 Stage 6 Native Runtime Contract Evidence

## Scope

- Enforces the shipped Gemma dispatch path for managed Eliza-1 bundles: `turboquant_q4`, Gemma flash attention, stock KV cache, and drafter-backed MTP.
- Fails closed when a managed hosted-MTP bundle is missing its drafter GGUF instead of silently degrading to non-speculative decode.
- Marks QJL, PolarQuant, and turbo3_tcq as legacy/non-Gemma KV routes in the native kernel contract.
- Adds an MTP doctor check for hosted drafter coverage.

## Verification

Command:

```bash
bun run --cwd plugins/plugin-local-inference test \
  src/services/manifest/manifest.test.ts \
  src/services/required-kernels-gate.test.ts \
  src/services/load-args-drafter.fuzz.test.ts \
  src/services/mtp-doctor.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests  84 passed (84)
Duration  79.13s
```

Additional checks:

```bash
git diff --cached --check
```

Result: passed.

## Native Contract Verifier

Command:

```bash
node plugins/plugin-local-inference/native/verify/check_kernel_contract.mjs
```

Result: failed before hardware execution because the existing native contract still reports unrelated verifier drift: missing checked-in Metal/Vulkan source paths, stale platform target names, and missing historical report files. This PR adds the Gemma runtime dispatch contract and tests the TypeScript activation gate; it does not claim the full native hardware matrix is green.

## Screenshots / Recordings / Live Model Trajectories

N/A - this chunk changes local native inference activation contracts and tests, not UI, audio, or model prompt behavior. Real on-device/platform capture remains required to fully close #12323 after the native kernel verifier drift and hardware matrix are resolved.
