# Windows Store Compatibility Report — elizaOS

## 1. Microsoft Store policy summary (policies that affect us)

Source: Microsoft Store Policies v7.19 (effective 2025-10-14) and MSIX desktop-to-uwp docs.

**Security and code-execution rules (most consequential for us):**
- **10.2.2 — Dynamic code:** Products "must not attempt to fundamentally change or extend its described functionality… through any form of dynamic inclusion of code." Downloading and executing scripts not consistent with the described functionality is grounds for rejection. This is the rule that bites code-execution / plugin-install / agent-shell flows hardest.
- **10.2.3 — No installing secondary software** the developer did not author. Hard cap on us bundling/installing third-party CLIs (`bun`, `node`, `codex`, `claude`, ngrok, tailscale, ffmpeg).
- **10.2.4 — Disclosed dependencies:** Non-integrated software dependencies must be disclosed at the start of the description. Non-Microsoft drivers/NT services generally not allowed.
- **10.2.6 — Crypto mining apps are not allowed on-device.** Wallet/view apps are OK; trading platforms must come from a Company account.
- **10.2.8** — Cannot modify Windows settings or user experience via accessibility APIs or undocumented APIs. Direct impact on plugin-computeruse.
- **10.6 — Capabilities** must legitimately match function. No circumventing AppContainer checks.
- **10.8.3 — Financial information & 10.8.1 — IAP:** Apps that take credit cards, private keys, or recovery phrases must be submitted from a Company account. Digital-goods purchases on Xbox must use Microsoft IAP (not relevant on PC, but our wallet/Hyperliquid/Polymarket plugins are scored under 10.8.3).
- **11.7 / 11.9 — Adult / obscene content prohibited.**
- **11.14 — Real-world gambling:** 18+ rating, third-party payment API, and *prohibited in the US, China, Russia, India, Brazil, Chile, Singapore, Taiwan, Korea*. Polymarket and similar prediction-market features would trigger this.
- **11.16 — Live generative AI content** must be disclosed in metadata, disclosed in Partner Center, and provide a user-reporting mechanism. **We must declare this.**
- **10.5.1 — Privacy policy** mandatory for any product that accesses Personal Information. Required regardless for "Desktop Bridge / Win32 products."

**MSIX desktop packaging (from desktop-to-uwp docs):**
- Full-trust desktop apps need `runFullTrust` (restricted capability) and `EntryPoint="Windows.FullTrustApplication"`. These pass WACK only after a manual Partner Center review.
- AppContainer-sandboxed packages (our `store` variant) cannot:
  - Spawn arbitrary executables outside the package.
  - Bind to non-loopback ports without `internetClientServer` / `privateNetworkClientServer`.
  - Touch `%USERPROFILE%` outside virtualized per-app paths.
  - Load native modules from paths the package doesn't own.
- WACK checks: PE signing (Authenticode), banned API usage (kernel/undocumented APIs), runtime registry/file writes outside container, supported file types, debug builds (`/DEBUG` excluded), `/DYNAMICBASE`, `/NXCOMPAT` flags on every PE.

## 2. Packaging path — already wired

We are **Electrobun-based**, not Electron and not Capacitor (Capacitor exists only for mobile builds).

Two MSIX manifests already exist:
- `C:/Users/Administrator/Documents/eliza/packages/app-core/packaging/msix/AppxManifest.xml` — full-trust (`runFullTrust`, `Windows.FullTrustApplication`) for direct download.
- `C:/Users/Administrator/Documents/eliza/packages/app-core/packaging/msix/AppxManifest.store.xml` — AppContainer-sandboxed, only `internetClient` and `internetClientServer`.

Build pipeline: `C:/Users/Administrator/Documents/eliza/packages/app-core/packaging/msix/build-msix.ps1`, selected by `ELIZA_BUILD_VARIANT={store|direct}`. Identity/Publisher are placeholder (`ElizaOS.App` / `CN=elizaOS`) overridable by `ELIZA_MSIX_IDENTITY_NAME` / `ELIZA_MSIX_PUBLISHER_ID` / `ELIZA_MSIX_PUBLISHER_DISPLAY_NAME` at CI time. Listing template lives at `packaging/msix/store/listing.json` (category Productivity, ageRating 12+, pricing free) — `publisher` and `screenshots[]` still placeholders.

A runtime-mode gating layer (`packages/shared/src/config/runtime-mode.ts` — `cloud` / `local-safe` / `local-yolo`) is the intended chokepoint to disable local-execution surfaces when the store build is active.

## 3. Code patterns that violate Store policies (file:line)

Hard violators — must not run in the store-build path:

- **Shell execution (10.2.2 dynamic code, AppContainer blocked):**
  - `plugins/plugin-coding-tools/src/lib/run-shell.ts:10` — `import { spawn } from "node:child_process"`. The SHELL action chokepoint.
  - `plugins/plugin-coding-tools/src/actions/bash.ts` — bash action.
  - `plugins/plugin-shell/utils/shellUtils.ts` — entire plugin is a shell. **Must be excluded from store build.**
  - `plugins/plugin-executecode/**` — `EXECUTE_CODE` action runs code at runtime; this is the canonical 10.2.2 violation. **Must be excluded.**
  - `plugins/plugin-agent-orchestrator/src/services/pty-service.ts`, `plugins/plugin-agent-orchestrator/src/services/workspace-service.ts`, `plugins/plugin-agent-orchestrator/src/services/spawn-trajectory.ts` — PTY + child spawn for coding sub-agents.
  - `plugins/plugin-coding-tools/src/actions/enter-worktree.ts`, `exit-worktree.ts` — git worktree spawns.
  - `plugins/plugin-codex-cli/**`, `plugins/plugin-commands/**`, `plugins/plugin-cli/**` — shell out to external binaries.
  - `plugins/plugin-computeruse/src/platform/*.ts` — `windows-list.ts`, `displays.ts`, `process-list.ts`, `browser.ts`, `capture.ts` use child_process for OS introspection. **Violates 10.2.8** (accessing protected windowing APIs).

- **PATH-lookup spawn of unsigned external CLIs (10.2.3):**
  - `plugins/plugin-agent-orchestrator/src/services/pty-init.ts` — `resolveNodeWorkerPath()` walks `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.nvm/...` searching for node/bun/codex/claude. AppContainer cannot reach any of those, and store policy prohibits installing/using arbitrary external CLIs as runtime dependencies.

- **Local servers binding ports (capability-required, sometimes fine):**
  - `packages/app-core/platforms/electrobun/src/native/loopback-port.ts`, `screenshot-dev-server.ts`, `desktop-test-bridge-server.ts`, `browser-workspace-bridge-server.ts` — loopback servers. `internetClientServer` covers loopback under AppContainer (this is allowed).
  - `plugins/plugin-tailscale/src/services/LocalTailscaleService.ts` and `plugins/plugin-ngrok/src/services/NgrokService.ts` — bring up tunnels / network daemons. **Both violate 10.2.3** (Tailscale, ngrok are unsigned-by-us binaries) and need `privateNetworkClientServer` plus likely external-CLI installs. **Exclude.**

- **Downloads at runtime (10.2.2 / 10.2.3):**
  - `plugins/plugin-local-inference/src/services/voice/kokoro/voice-presets.ts`, `voices.ts`, `kokoro-runtime.ts`, `eot-classifier.ts`, `system-audio-sink.ts`, `mic-source.ts`, `verify-on-device.ts`, `service.ts`, `manifest/schema.ts`, `local-inference-routes.ts` — download model weights from `huggingface.co` at runtime. *Model weights are data, not executable code; this is generally OK* under 10.2.2 as long as we are not downloading native libraries. But weights pulled by `node-llama-cpp` come alongside platform binaries — if any code path pulls a `.dll`/`.so`/`.node` it is a hard violation.
  - `plugins/plugin-vision/src/yolo-detector.ts`, `ocr-service-rapid.ts`, `face-detector-mediapipe.ts` — same pattern (ONNX/RapidOCR models). OK if weights only.
  - `plugins/plugin-video/src/services/binaries.ts` — name suggests ffmpeg binary download. **Hard violation of 10.2.3 if it pulls an .exe.**

- **Dynamic code evaluation (10.2.2):**
  - `packages/core/src/utils.ts`, `packages/core/src/features/advanced-capabilities/personality/services/character-file-manager.ts`, `packages/app-core/src/runtime/mobile-safe-runtime.ts`, `packages/app-core/platforms/electrobun/src/rpc-handlers.ts` — flagged for `new Function(`/`eval(`/`vm.runIn`. Need to be audited; if these execute user-supplied or downloaded strings the store build fails. Inspect each before submission.

- **Crypto wallets / financial (10.2.6, 10.8.3):**
  - `plugins/app-wallet`, `plugins/plugin-wallet` — wallet UI is fine; storing private keys / recovery phrases triggers **10.8.3 Company-account requirement.**
  - `plugins/app-hyperliquid`, `plugins/app-polymarket`, `plugins/plugin-x402` — perpetuals/prediction-market UIs. Polymarket is real-world gambling under **11.14**: prohibited in US/CN/RU/IN/BR/CL/SG/TW/KR and requires 18+ rating + third-party payment API. **Exclude from store build** or geo-restrict.
  - `plugins/plugin-tee`, `plugins/plugin-rlm` — review for crypto-mining (10.2.6).

- **Content / NSFW:**
  - No plugin self-identifies as adult or NSFW (grep on `gambling|porn|nsfw|adult|sexual` returned only an omnivoice descriptor `"female young adult moderate happy"` — voice prompt, harmless). The risk is generative-AI output (11.7 / 11.16). We must add 11.16 disclosure and a user-reporting mechanism for AI content.

## 4. Native dependency audit (must pass WACK)

`.node` modules and native DLLs we ship on win32-x64:

- `@node-llama-cpp/win-x64`, `@node-llama-cpp/win-x64-cuda`, `@node-llama-cpp/win-x64-vulkan` → `llama-addon.node` (3 variants).
- `@img/sharp-win32-x64` → `sharp-win32-x64.node` (libvips inside).
- `onnxruntime-node` → `onnxruntime_binding.node` + bundled `onnxruntime.dll`.
- `@napi-rs/canvas-win32-x64-msvc` → `skia.win32-x64-msvc.node`.
- `@napi-rs/keyring-win32-x64-msvc` → `keyring.win32-x64-msvc.node` (uses DPAPI; **AppContainer-friendly**).
- `@node-rs/argon2-win32-x64-msvc`.
- `keccak`, `bufferutil`, `utf-8-validate` prebuilds.
- `@ngrok/ngrok-win32-x64-msvc`, `@nut-tree-fork/libnut-win32`, `node-pty` (`conpty.node`, `conpty_console_list.node`, `pty.node`) — **all three are AppContainer-hostile.** node-pty's `conpty.node` spawns ConPTY processes which AppContainer blocks; libnut hooks global input which violates 10.2.8; ngrok is a network daemon.
- `canvas@3.2.3` (Cairo-based) — also bundled; potentially redundant with `@napi-rs/canvas`.
- `@snazzah/davey-win32-x64-msvc` — Discord voice (Opus). Inspect for static-init network calls.
- `@nomicfoundation/edr-win32-x64-msvc`, `@nomicfoundation/solidity-analyzer-win32-x64-msvc` — Hardhat (dev tools). **Should not ship in the runtime bundle at all.**

WACK requires every PE to be Authenticode-signed with a Microsoft Trusted Root cert. `node_modules` prebuilds are not signed. We must either:
1. Co-sign every `.node` / `.dll` inside the MSIX with our cert before `makeappx pack` (current `build-msix.ps1` signs the MSIX itself but not contents); or
2. Use Azure Trusted Signing on the bundle — but each PE still needs to chain to a trusted root or WACK flags it as "binary not signed".

## 5. Networking

Servers we bind locally (audited): main API server, auth bridge, screenshot dev server, desktop test bridge, browser workspace bridge, benchmark server, steward sidecar — all loopback. `internetClientServer` covers this in AppContainer. No raw sockets observed. **One concern:** dev-only servers must be tree-shaken out of the store build — if a screenshot-dev-server or desktop-test-bridge ends up running in production it will trip 10.4.2 ("must not run unexpected services") on inspection.

## 6. Content / feature audit

| Plugin | Concern | Disposition |
|---|---|---|
| `plugin-executecode` | 10.2.2 dynamic code | **Exclude from store build** |
| `plugin-shell`, `plugin-coding-tools`, `plugin-commands`, `plugin-cli`, `plugin-codex-cli` | 10.2.2/10.2.3 shell-out | **Exclude** |
| `plugin-computeruse` | 10.2.8 unsupported UI automation | **Exclude** |
| `plugin-agent-orchestrator` | PTY, sub-agent spawn | **Exclude** (or stub to cloud-only) |
| `plugin-tailscale`, `plugin-ngrok`, `plugin-tunnel` | 10.2.3 installs network daemons | **Exclude** |
| `plugin-background-runner` | Background process orchestration | **Exclude** |
| `plugin-mcp` | Spawns user-supplied MCP servers (10.2.2/10.2.3) | **Exclude** for store |
| `app-polymarket` | 11.14 gambling | **Exclude** (or geo-restrict + 18+) |
| `app-hyperliquid`, `plugin-x402` | 10.8.3 financial | Allowed only via Company account + third-party payment API |
| `app-wallet`, `plugin-wallet` | 10.2.6 / 10.8.3 | View-only OK; key custody triggers 10.8.3 |
| `plugin-tee`, `plugin-rlm` | Possible 10.2.6 crypto | Audit before inclusion |
| `plugin-local-inference`, `plugin-vision`, `plugin-local-ai`, `plugin-mlx` | Local model weights download | Allowed if weights-only; **block native binary downloads** |
| `plugin-video/services/binaries.ts` | Likely ffmpeg download | **Exclude or bundle pre-signed** |
| `app-2004scape`, `app-babylon`, `app-hyperscape`, `app-clawville`, `app-scape`, `app-defense-of-the-agents` | Game-like apps | Re-categorize listing or split — current `category: "Productivity"` is inaccurate per 10.1.1 if these are present in the store build |
| `app-google-meet-cute`, `plugin-mysticism` | Content review for 11.5/11.9 | Audit for offensive content |
| All AI surfaces | **11.16 generative AI** | Add disclosure + report-content UI |

## 7. MSIX manifest skeleton (store variant — annotated)

```xml
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 rescap">

  <Identity
    Name="REPLACE_FROM_PARTNER_CENTER"
    Publisher="CN=REPLACE_FROM_PARTNER_CENTER"
    Version="2.0.0.0"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>elizaOS App</DisplayName>
    <PublisherDisplayName>elizaOS Labs</PublisherDisplayName>
    <Logo>assets\StoreLogo.png</Logo>
    <Description>Personal AI assistant — cloud-hosted agents (sandboxed build).</Description>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop"
      MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Applications>
    <Application Id="ElizaOSApp" Executable="launcher.exe">
      <!-- NOTE: no EntryPoint="Windows.FullTrustApplication" -->
      <uap:VisualElements
        DisplayName="elizaOS App"
        Description="Personal AI assistant"
        BackgroundColor="transparent"
        Square150x150Logo="assets\Square150x150Logo.png"
        Square44x44Logo="assets\Square44x44Logo.png">
        <uap:DefaultTile
          Wide310x150Logo="assets\Wide310x150Logo.png"
          Square310x310Logo="assets\LargeTile.png" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="elizaos-app" />
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>

  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="internetClientServer" />
    <DeviceCapability Name="microphone" />
    <DeviceCapability Name="webcam" />
  </Capabilities>
</Package>
```

Do NOT add: `runFullTrust`, `broadFileSystemAccess`, `allowElevation`, `packageManagement`.

## 8. WACK pre-flight checklist

Run `appcert.exe test -appxpackagepath out-store.msix -reportoutputpath wack.xml` after `makeappx pack` and verify:

- [ ] Every PE in the package is Authenticode-signed (chains to Microsoft Trusted Root).
- [ ] Every PE has `/DYNAMICBASE`, `/NXCOMPAT`, no `/DEBUG` flags. Run `dumpbin /headers` per binary.
- [ ] No banned-API imports (`OutputDebugString` is OK but ensure no `CreateProcess` from packaged code).
- [ ] Package contains a valid AppxManifest.xml that opens in AppContainer (no `runFullTrust`).
- [ ] Identity matches Partner Center registration exactly.
- [ ] Resources resource pack passes `MakePri` validation.
- [ ] App launches into AppContainer (Task Manager → Details → AppContainer column = Yes).
- [ ] Loopback API reachable without firewall prompt; outbound HTTPS to cloud succeeds.
- [ ] No `%USERPROFILE%` writes outside the per-app virtualized path (verify with Process Monitor).
- [ ] No process spawns blocked by AppContainer at runtime (Event Viewer → AppLocker).
- [ ] Privacy URL, support URL, age rating filled in Partner Center.
- [ ] 11.16 live-AI disclosure ticked in Partner Center submission.

## 9. Prioritized fix plan

**P0 — blocks submission:**
1. Replace identity placeholders in `AppxManifest.store.xml` and `store/listing.json` with Partner-Center-issued values (Identity.Name, Publisher CN GUID, PublisherDisplayName).
2. Build the store variant with **plugins excluded** at bundling: `plugin-shell`, `plugin-executecode`, `plugin-coding-tools`, `plugin-commands`, `plugin-cli`, `plugin-codex-cli`, `plugin-computeruse`, `plugin-agent-orchestrator`, `plugin-tailscale`, `plugin-ngrok`, `plugin-tunnel`, `plugin-background-runner`, `plugin-mcp`, `app-polymarket`. Wire `plugins.json` filtering through `ELIZA_BUILD_VARIANT=store`.
3. Hard-error at runtime if `resolveRuntimeExecutionMode` is anything but `cloud` when `ELIZA_BUILD_VARIANT=store`. Today it's "should" — make it enforced (`packages/shared/src/config/runtime-mode.ts`).
4. Sign every `.node` and `.dll` in the staging dir before `makeappx pack`. Extend `build-msix.ps1` with a `signtool sign` loop over `*.dll`, `*.node`, `*.exe` under `$msixStaging`. Use the same Azure Trusted Signing identity as the launcher.
5. Remove dev-only `node_modules`: `@nomicfoundation/*` (Hardhat), `@swc/*`, `@rolldown/*`, `@oxc-*`, `lightningcss-*` from the runtime bundle. Today they are copied via `runtimeBundleNodeModulesDir`.

**P1 — required for cert pass:**
6. Audit each `eval`/`new Function` site (`packages/core/src/utils.ts`, `character-file-manager.ts`, `mobile-safe-runtime.ts`, `rpc-handlers.ts`). Either remove or prove the inputs are static and Store-reviewer-defensible.
7. Audit `plugins/plugin-video/src/services/binaries.ts` — if it downloads ffmpeg.exe at runtime, either bundle a signed copy or exclude the plugin from store.
8. Replace `node-pty` / `libnut` references with stubs in the store bundle (already excluded by plugin removal, verify with `dumpbin` that the binaries are not in the package).
9. Add 11.16 live-AI disclosure: short paragraph at the top of the listing description, "Notes for certification" entry in Partner Center, and an in-app "Report content" button on AI outputs.
10. Tighten `Capabilities`: only declare `microphone` / `webcam` if voice/vision features ship in the store build. Otherwise omit; over-declaration is a 10.6 finding.

**P2 — polish + post-launch:**
11. Categorize correctly per 10.1.1 — if game-like `app-*` apps ship, category should be "Entertainment > Casual Games", not Productivity.
12. Geo-restrict any wallet/finance plugin to non-prohibited markets (set in Partner Center "Markets and exclusions").
13. Privacy policy at `https://app.elizaos.ai/privacy` must enumerate data classes our cloud APIs receive (10.5.1 / 10.5.5).
14. Add a privacy-policy in-app link reachable from first-run and Settings.
15. Validate `xmllint --noout` on both manifests in CI.

**Bottom line:** the store build path is already 80% scaffolded — manifest split, build variant flag, runtime-mode gating, signing hooks. Remaining work is mechanical: (a) plugin exclusion list wired into the bundler, (b) signtool loop over inner PEs, (c) Partner-Center identity substitution, (d) 11.16 disclosure, (e) drop dev-tool native modules from the runtime bundle. Submission should be feasible within 1–2 sprints once those are landed and WACK runs clean on a Windows host.
