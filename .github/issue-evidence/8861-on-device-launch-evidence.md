# #8861 / on-device — Eliza app launching on a real iPhone

Device: **MoonCycles — iPhone 16 Pro Max (iPhone17,2), iOS 18.7.8, developer mode enabled.**
(Also installed on Shaw's iPhone 15 Pro, iOS 26.5.)

`ai.elizaos.app` and `ai.elizaos.app` are **installed on the physical device**
(`xcrun devicectl device info apps`). Launched live via
`xcrun devicectl device process launch ai.elizaos.app` — SpringBoard activated
the scene (full OpenApplication transition, maximized portrait), confirmed in
the device syslog (2362 app-scoped lines).

On-device signing + entitlements (from the device syslog, SpringBoard Security):
```
application-identifier              : 25877RY2EH.ai.elizaos.app
team-identifier                     : 25877RY2EH
aps-environment                     : development
com.apple.developer.kernel.extended-virtual-addressing : true   ← full-Bun engine large mmap
com.apple.developer.kernel.increased-memory-limit      : true   ← on-device model in RAM
com.apple.developer.healthkit (+ background-delivery)  : true
com.apple.developer.family-controls                    : true
com.apple.security.application-groups : group.ai.elizaos.app
```

The `increased-memory-limit` + `extended-virtual-addressing` entitlements are the
ones the on-device local-inference (full-Bun) engine needs to load a GGUF into
RAM — present and signed on the real device.

Remaining for full TestFlight/App-Store close: the signed **Release** archive +
App Store Connect upload (operator + signing-cert lane); on-device screenshots
need the iOS-18 developer tunnel (root) which isn't available in this CLI env.
