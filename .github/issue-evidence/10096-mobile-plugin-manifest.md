# Issue 10096 — mobile plugin manifest evidence

Scope: derives Android Capacitor package patching, iOS official pods, iOS custom
pods, and CocoaPods-owned SPM strip sets from one annotated manifest in
`packages/app-core/scripts/run-mobile-build.mjs`.

Manual review:

- Confirmed the manifest preserves the previous Android package list, including
  `@capacitor-community/background-runner` and excluding `@capacitor/network`.
- Confirmed the iOS official pod list is derived from manifest entries marked
  `kind: "official"`.
- Confirmed the conditional iOS custom pod behavior stayed the same:
  default custom pods are always present; Bun runtime pods follow the Bun
  runtime gates; the mobile-agent bridge stays out of App Store builds; llama
  pods stay out of App Store builds even when requested.
- Confirmed the CocoaPods-owned SPM strip set is derived from manifest
  `spmHandling: "cocoapods-owned"` annotations.

Verification run on the rebased branch:

```bash
bunx biome check packages/app-core/scripts/run-mobile-build.mjs packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs
# Checked 2 files. No fixes applied.

bun run --cwd packages/app-core test -- scripts/run-mobile-build-plugin-manifest.test.mjs
# Test Files 1 passed (1)
# Tests 3 passed (3)

bun test packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs packages/app-core/scripts/run-mobile-build-android-app-actions.test.mjs packages/app-core/scripts/run-mobile-build-ios-engine-gate.test.mjs packages/app-core/scripts/run-mobile-build-brand-separation.test.mts
# 27 pass
# 0 fail

node --check packages/app-core/scripts/run-mobile-build.mjs
node --check packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs
# no syntax errors
```

Repo-wide verification notes:

- `bun run verify` passed the type-safety ratchet, then the process was killed
  with exit 137 before Turbo typecheck/lint started.
- `bun run --cwd packages/app-core typecheck` fails on unrelated/generated or
  optional-package surfaces in the current checkout, including missing generated
  i18n data, missing optional Capacitor/contracts packages, account UI type
  drift, and `@elizaos/tui`/`@elizaos/cloud-routing` resolution errors.

Evidence marked N/A:

- UI screenshots/video: N/A, no user-facing UI change.
- Live LLM trajectory: N/A, no prompt/model/agent behavior change.
- Native device capture: N/A for this PR slice; the change only deduplicates
  package/pod mapping helpers and is covered by script-level regression tests.
