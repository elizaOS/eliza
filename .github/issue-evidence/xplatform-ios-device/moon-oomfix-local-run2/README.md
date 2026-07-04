# On-device local-LLM reply capture — MoonCycles (iPhone 16 Pro Max, A18, iOS 18.7.8)

Deployed the **#11612-fixed build** (recoverable Metal failure + bf16 kernel + GPU-OOM admission `n_ubatch=256`) to the real device via `ios-device-deploy` (build → sign → install → launch — all succeeded).

## Definitive blocker: WKWebView onboarding is invisible to XCUITest
`BootCaptureUITests.testLocalOnboardingChatAndVoice` skipped after 300s: "placement choice 'On this device' never surfaced." But the attached screenshot `14927998-*.png` shows the placement choice **fully rendered** — "Hi — I'm Eliza… where should your agent run? / Eliza Cloud (managed) / **On this device** / Connect to a remote agent". So the control **is** on screen; XCUITest's element tree simply does not expose the Capacitor WKWebView's buttons or static texts. The hardened `tapWebChoice` (exact + CONTAINS label match + coordinate-tap on a matching staticText) cannot help because **no** web element — button or text — is in the query tree.

Every autonomous real-device UI-driving path is exhausted:
- `idb ui tap` — simulator-only (`Target doesn't conform to FBSimulatorLifecycleCommands`).
- **XCUITest** — WKWebView content invisible to the element tree (proven above).
- `pymobiledevice3` — screenshot/perf only; no touch injection.
- deep link `elizaos://ask?text=…` — prefill-only, no auto-send.

## What IS verified on the real device
- Build installs + launches; onboarding renders; agent wakes ("Eliza is taking longer than usual to wake…").
- Prior device runs: **STT proven live**; crash-loop fixed; **bf16 kernel loads** (`../11612-bf16-retest/ggml-device-postfix.log`); GPU-OOM fix shipped (fit math 5018<5461 MiB).

## Remaining to capture the generated *reply*
Either (a) a physical tap on "On this device" + a typed message (the WKWebView is only human-tappable given the current accessibility), or (b) an app-level change to expose the onboarding WKWebView controls to XCUITest (a real testability improvement — filed as follow-up). The `tapWebChoice` hardening is retained as a partial improvement for any web content that *is* exposed.
