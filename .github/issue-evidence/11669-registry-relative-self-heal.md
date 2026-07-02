# Issue #11669 — container-relative registry paths + self-heal of legacy absolute rows

## Root cause

`local-inference/registry.json` persisted absolute paths into the iOS app data
container. iOS rotates the data-container UUID on reinstall/update, so the
persisted prefix dies while the model bytes migrate fine. #11371 made the
canonical registry writer store container-relative rows and re-anchor legacy
absolute rows at hydrate time, but three gaps remained:

1. `plugin-local-inference` hydration never verified the re-anchored artifact
   actually exists, and never rewrote the healed rows back to disk — the
   legacy absolute strings lived in `registry.json` forever.
2. `plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts` (the
   on-device full-Bun loader path) resolved stored rows **verbatim** with
   `existsSync`, so BOTH the new relative rows and legacy dead-container
   absolute rows failed, and the bootstrap fell through to re-downloading a
   model that was already fully present on disk.
3. `plugin-aosp-local-inference` (Android) `mapExistingModelPath` handled
   legacy absolute rows but not the new container-relative rows.

## What changed

- `plugin-local-inference/src/services/registry.ts`:
  `listInstalledModels()` verifies the model artifact exists at the hydrated
  path, drops rows whose file is genuinely absent (structured
  `[LocalInferenceRegistry]` warn; readiness/UI then surface the real
  not-downloaded state), and self-heals `registry.json` once — legacy rows are
  rewritten in canonical relative form via the existing atomic tmp+rename
  writer. Hydration no longer leaks a raw stored `bundleRoot`/`manifestPath`
  string when resolution fails.
- `plugin-capacitor-bridge/src/shared/local-inference-stored-path.ts` (new):
  shared stored-path resolver — relative rows join the CURRENT root; legacy
  absolute rows re-anchor by their `/local-inference/` suffix (plus the
  simulator `/private/var` ↔ `/var` alias); every candidate is
  exists-verified; traversal rows are rejected. The exists probe is injectable
  so the iOS stdio bridge keeps probing through the mobile fs sandbox proxy.
- `plugin-capacitor-bridge/src/ios/bridge.ts`: deduped its local copy of the
  same logic into the shared resolver (behavior preserved).
- `plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts`:
  `resolveFromRegistry` / `resolveAssignedRegistryModel` resolve rows through
  the shared resolver instead of verbatim `existsSync`.
- `plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts`:
  `mapExistingModelPath` maps container-relative rows against the parent of
  `modelsDir` (the local-inference dir), keeping Android on the same format.

## Regression evidence (container migration simulated by moving the root)

- `plugins/plugin-local-inference/src/services/registry.test.ts` (8 tests)
  - moved-root reanchor now ALSO asserts the on-disk rows are rewritten in
    canonical relative form (self-heal persists once);
  - legacy absolute row with no artifact under the current root → dropped
    from the listing AND from `registry.json` (real not-downloaded state);
  - relative row whose artifact was deleted → same;
  - mixed registry: healthy row kept + healed relative, dead row dropped.
- `plugins/plugin-capacitor-bridge/src/shared/local-inference-stored-path.test.ts`
  (10 tests): relative resolve, dead-container re-anchor using the exact path
  shape from the issue, `/private/var` alias, traversal rejection, round-trip,
  genuinely-absent → null.
- `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.registry-paths.test.ts`
  (3 tests): `mobileDeviceBridge.status().modelPath` resolves a relative row,
  re-anchors a dead-container absolute row, and reports null when the artifact
  is genuinely absent.
- `plugins/plugin-aosp-local-inference/__tests__/aosp-local-inference-bootstrap.test.ts`
  (+2 tests): `readAssignedBundledModels` resolves container-relative rows and
  returns null when the artifact is absent.

## Anti-larp negative check

Temporarily reverted the three source files to `origin/develop` and re-ran the
new tests:

- bootstrap registry-paths: **2/3 failed** (relative row + dead-container
  re-anchor) — exactly the two bugs;
- registry self-heal: **4/8 failed** (the four new heal/drop tests);
- AOSP relative-row test: **failed**.

Restored the fix; all green again.

## Commands run

```bash
bunx vitest run --root plugins/plugin-local-inference
# 224 passed / 1 failed (pre-existing env failure, also fails on pristine
# origin/develop checkout: imagegen-backend-selector "Linux NVIDIA without
# sd-cpp CUDA proof" — host has a cached CUDA proof; unrelated to this change)
# 2272 tests passed, 13 skipped

bunx vitest run --root plugins/plugin-capacitor-bridge
# 7/8 files passed; the 2 failures in
# mobile-device-bridge-bootstrap.serving-status.test.ts are pre-existing on
# macOS (abstract \0 sockets are Linux-only; fails identically on pristine
# origin/develop)

bun run --cwd plugins/plugin-aosp-local-inference test   # 75 pass / 0 fail

bun run --cwd plugins/plugin-local-inference typecheck   # pass
bun run --cwd plugins/plugin-capacitor-bridge typecheck  # pass
bun run --cwd plugins/plugin-aosp-local-inference typecheck  # pass

bun run --cwd plugins/plugin-local-inference build       # pass
bun run --cwd plugins/plugin-capacitor-bridge build      # pass
bun run --cwd plugins/plugin-aosp-local-inference build  # pass

bunx @biomejs/biome check <all touched files>            # clean
```

## Device verification status

The container-migration failure mode is exercised directly by the moved-root
regression tests above (write registry under root A, resolve under root B —
the same state transition an iOS container-UUID rotation produces). A live
iOS reinstall capture (install → download 6.5 GB bundle → `simctl install` a
new build → verify the model loads from the migrated container) requires the
full device bundle and was not run on this branch; that leg follows the
`capture:ios-sim` lane from PR_EVIDENCE.md. No UI, prompt, or model behavior
changed; server-side path resolution only.
