# @elizaos/capacitor-network-policy

Capacitor plugin that surfaces Android `metered` and iOS `isExpensive`/`isConstrained` network-link hints to Eliza agents running on mobile.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin — not a standard elizaOS plugin registered via `Plugin` object. It bridges OS-level network-metering signals to TypeScript for use by the voice-model auto-updater (R5-versioning §4). On import it installs `globalThis.ElizaNetworkPolicy` so `plugin-local-inference/src/services/network-policy.ts` can query the bridge without a compile-time Capacitor dependency. It is loaded explicitly by the mobile app bootstrap — it is not auto-enabled by the elizaOS runtime.

## Plugin surface

This plugin does **not** register elizaOS actions, providers, services, evaluators, routes, or events. It is a Capacitor bridge plugin only.

Capacitor bridge name: `ElizaNetworkPolicy`

Exported TypeScript API (from `src/definitions.ts`):

| Symbol | Description |
|--------|-------------|
| `NetworkPolicy` | Capacitor plugin handle registered as `"ElizaNetworkPolicy"`. |
| `installNetworkPolicyGlobal()` | Installs `globalThis.ElizaNetworkPolicy`. Called as a side-effect on import. |
| `NetworkPolicyPlugin` | Interface with two methods (see below). |
| `MeteredHint` | Return type of `getMeteredHint()` — `{ metered: boolean | null, source: "android-os" }`. |
| `PathHints` | Return type of `getPathHints()` — `{ isExpensive: boolean, isConstrained: boolean, source: "nw-path-monitor" }`. |

Bridge methods:

| Method | Platform | What it reads |
|--------|----------|----------------|
| `getMeteredHint()` | Android (safe fallback on iOS/web) | `ConnectivityManager.getNetworkCapabilities(activeNetwork).hasCapability(NET_CAPABILITY_NOT_METERED)`. Returns `metered: null` when there is no active network, permission is denied, or the capability object is unavailable. |
| `getPathHints()` | iOS (safe fallback on Android/web) | `NWPathMonitor.currentPath.isExpensive` and `.isConstrained`. Returns `false/false` on Android. |

Web fallback (`src/web.ts`): reads `navigator.connection.saveData`; returns `metered: true` when `saveData` is true, `metered: null` when `saveData` is false or unavailable — never assumes "not metered", so the policy decision falls through to `unknown → ask`.

## Layout

```
plugins/plugin-native-network-policy/
  src/
    definitions.ts          TypeScript interfaces: MeteredHint, PathHints, NetworkPolicyPlugin
    index.ts                registerPlugin("ElizaNetworkPolicy") + installNetworkPolicyGlobal()
    web.ts                  Browser WebPlugin fallback (navigator.connection.saveData)
    web.test.ts             Vitest unit tests for the web fallback
  android/
    src/main/java/ai/eliza/plugins/networkpolicy/
      NetworkPolicyPlugin.kt  Android impl — ConnectivityManager + NET_CAPABILITY_NOT_METERED
  ios/
    Sources/NetworkPolicyPlugin/
      NetworkPolicyPlugin.swift  iOS impl — NWPathMonitor (long-lived, read on demand)
  ElizaosCapacitorNetworkPolicy.podspec  CocoaPods spec (iOS 13+, Swift 5.1)
  rollup.config.mjs          Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js)
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-network-policy clean           # remove build output
bun run --cwd plugins/plugin-native-network-policy build           # build package artifacts
bun run --cwd plugins/plugin-native-network-policy typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-network-policy lint            # mutating Biome check
bun run --cwd plugins/plugin-native-network-policy lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-network-policy format          # write formatting
bun run --cwd plugins/plugin-native-network-policy format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-network-policy test            # run package tests
bun run --cwd plugins/plugin-native-network-policy prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-network-policy build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

None. This plugin reads no environment variables and has no elizaOS `settings` fields. All behavior is determined at runtime by the OS network state.

## How to extend

**Add a new bridge method:**

1. Add the method signature to `src/definitions.ts` (`NetworkPolicyPlugin` interface) with its return type interface.
2. Implement the method in `src/web.ts` (`NetworkPolicyWeb` class) — return a safe conservative default.
3. Implement in `android/src/main/java/ai/eliza/plugins/networkpolicy/NetworkPolicyPlugin.kt` — annotate with `@PluginMethod`.
4. Implement in `ios/Sources/NetworkPolicyPlugin/NetworkPolicyPlugin.swift` — add a `CAPPluginMethod` entry to `pluginMethods` and an `@objc func`.
5. Re-export from `src/index.ts` if needed; `export * from "./definitions"` already covers new interfaces there.

## Conventions / gotchas

- **Not a standard elizaOS plugin.** There is no `Plugin` object, no `actions`/`providers` array. The Capacitor bridge is the surface.
- **Side-effect on import.** Importing `@elizaos/capacitor-network-policy` calls `installNetworkPolicyGlobal()` immediately — `globalThis.ElizaNetworkPolicy` is set as a side effect.
- **Platform symmetry:** both methods exist on both platforms and return conservative fallback values on the non-native platform. iOS callers should use `getPathHints()`; Android callers should use `getMeteredHint()`. The consuming code in `plugin-local-inference` is the authoritative caller — match its expectations.
- **`metered: null` means "unknown, ask the user"** — not "not metered." Do not conflate `null` with `false`.
- **iOS monitor lifecycle:** the Swift implementation keeps one long-lived `NWPathMonitor` started in `load()`. Do not start/stop it per call.
- **Android permission:** `ACCESS_NETWORK_STATE` is required in the app's `AndroidManifest.xml`. The plugin catches `SecurityException` and returns `metered: null` rather than crashing.
- **Build outputs:** `dist/plugin.js` (IIFE for web bundlers), `dist/plugin.cjs.js` (Node/CJS), `dist/esm/index.js` (ESM via tsc). The `bun`/`development` export conditions resolve directly to `src/index.ts`.
- **Peer dep:** `@capacitor/core ^8.3.1`. The consuming app must provide this.
- **CocoaPods:** `ElizaosCapacitorNetworkPolicy.podspec` targets iOS 13+. Swift 5.1 minimum.
- See the repo root `AGENTS.md` for repo-wide architecture rules, logger conventions, and commit workflow.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
