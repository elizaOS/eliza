# #8861 — iOS App Store full-Bun release: on-device / TestFlight verification runbook

The code + CI side of #8861 is **landed and verified on `develop`** (PRs #8859, #8860).
The remaining acceptance is **Apple-signing-secrets + macOS-CI + physical-iPhone gated** and
cannot be done in a headless / Linux agent run. This runbook is the checklist for the
maintainer who holds the signing secrets and a device.

> Goal: confirm the App Store / TestFlight build ships the on-device Bun engine and that
> "start local agent" boots the on-device runtime — i.e. the original failure
> *"the JSContext compatibility transport is disabled outside iOS development builds"*
> no longer occurs.

---

## 0. What is already proven on `develop` (no device needed)

These are verified on the current tree; do not re-do them, just rely on them:

- `.github/workflows/apple-store-release.yml` `build-ios` job env sets
  `ELIZA_BUILD_VARIANT=store`, `ELIZA_RELEASE_AUTHORITY=apple-app-store`,
  `ELIZA_IOS_FULL_BUN_ENGINE=1`, `VITE_ELIZA_IOS_FULL_BUN_AVAILABLE=1`,
  `VITE_ELIZA_IOS_RUNTIME_MODE=cloud-hybrid`; runs the **Build iOS agent bundle** step
  (`packages/agent` → `build:ios-bun`) before `ios-overlay`, then `preflight:ios:store`.
- `packages/app-core/scripts/run-mobile-build.mjs` `ios-overlay` stages the agent runtime
  (`stageIosAgentRuntime`) when `shouldIncludeIosFullBunEngine()` is true.
- `packages/app/scripts/mobile-release-preflight.mjs` (run as `preflight:ios:store`) **fails
  the build** if a store build would ship without the engine.
- `ElizaBunEngine.xcframework` is committed under
  `packages/native/bun-runtime/artifacts/` and resolved by the podspec default.
- Regression test: `bun test packages/app-core/scripts/run-mobile-build-ios-engine-gate.test.mjs`
  (asserts `shouldIncludeIosFullBunEngine()` is true for the store variant) — green on `develop`.

Sanity-re-verify the gate before kicking off the workflow:

```bash
bun test packages/app-core/scripts/run-mobile-build-ios-engine-gate.test.mjs
```

---

## 1. Prerequisites (maintainer holds these)

- A physical iPhone provisioned with an Apple ID added to Xcode (Settings → Accounts) on a
  Mac with Xcode 16+.
- Apple signing + App Store Connect secrets configured as GitHub Actions secrets:
  `MATCH_*` (fastlane match repo + passphrase), `APPLE_ID`, `ITC_TEAM_ID`,
  `APP_STORE_APP_ID`, and the App Store Connect API key vars the workflow's
  `Validate iOS secrets` step asserts.
- `develop` is the branch under test (or a release branch cut from it).

---

## 2. Path A — CI build + TestFlight (the acceptance path)

1. Run the **Apple Store Build & Publish** workflow (`apple-store-release.yml`) on `develop`
   with track `testflight`.
2. Confirm the macOS archive completes within the 90-min budget (the full-Bun build is
   heavier than the old thin client — watch for timeout on `runs-on: macos-15`).
3. In the build log, confirm:
   - the **Build iOS agent bundle** step produced `packages/agent` iOS bundle output;
   - `pod install` embedded `ElizaBunEngine.xcframework`;
   - the fastlane archive includes `App/public/agent/*` (the staged agent bundle from
     `stageIosAgentRuntime`);
   - `preflight:ios:store` passed (it would have failed the build otherwise).
4. Let the workflow upload to TestFlight; install the resulting build on the device.

## 2b. Path B — local device archive (faster iteration, same engine path)

From `packages/app`, the proven local recipe (no TestFlight upload — installs to a tethered
device via Xcode):

```bash
bun run --cwd packages/app build:ios:local:device:full-bun:release
# then open the generated Xcode project / archive and run on the connected device,
# or use the device install step in the mobile release pipeline spec.
```

Reference: `packages/app/docs/mobile-and-desktop-release-pipeline-spec.md`.

---

## 3. On-device acceptance checks (the 5 issue checkboxes)

Run on the installed build, capture evidence into `.github/issue-evidence/8861-*`:

- [ ] App launches; no immediate crash.
- [ ] Tap **"start local agent"** → the on-device agent boots. **No** error
      *"the JSContext compatibility transport is disabled outside iOS development builds"*
      or *"foreground ITTP compatibility transport disabled"*.
- [ ] Switch runtime mode to **local** → the choice **persists** across an app relaunch and
      the local agent still boots.
- [ ] First-use model download completes (the engine downloads the model on first run); a
      local inference turn produces tokens (real-Metal token-gen evidence — only obtainable
      on device, not the simulator).
- [ ] **cloud-hybrid default** still works: a cloud-inference turn succeeds (the default
      path must be unaffected by the engine embed).

Evidence to attach (per `PR_EVIDENCE.md`): a screen recording of the local-agent boot +
a token-generating turn, and a screenshot of the runtime-mode toggle persisting.

---

## 4. Risks to watch

- **CI time budget** — the engine pod + agent bundle make the archive heavier; if it times
  out, the build never reaches TestFlight.
- **Asset-staging path** — confirm `stageIosAgentRuntime` output at
  `ios/App/App/public/agent` survives the fastlane archive (step 3 above).
- **Engine ABI / model download** — the engine downloads the model on first launch; verify
  on a clean install over cellular + wifi.

## 5. Closing the issue

When all five checks above pass on a device with evidence attached, #8861 is complete.
Until then it remains an owner-gated device/TestFlight checklist — the code/CI side is done.
