# @elizaos/plugin-wifi

Android-only overlay app that lets an Eliza agent scan, inspect, and connect to nearby Wi-Fi networks.

## Purpose / role

Adds a Wi-Fi management surface to the elizaOS mobile agent on Android. It registers a `wifiNetworks` provider that injects nearby network context into the agent's planner, and a full-screen overlay UI (`WifiAppView`) that the user can open from the app catalog. The plugin is opt-in: it is only registered in the overlay app catalog when `isElizaOS()` returns true (i.e., running inside the elizaOS Android host). On all other platforms (iOS, desktop, web) the side-effect entry leaves the overlay app catalog unchanged.

## Plugin surface

The `/plugin` export (`src/plugin.ts`) registers:

| Kind | Name | Description |
|------|------|-------------|
| Provider | `wifiNetworks` | Dynamic, read-only nearby Wi-Fi networks (ssid, bssid, rssi, frequency, secured). Context gate: `system`. Cache scope: `turn`. Calls `@elizaos/capacitor-wifi` `WiFi.listAvailableNetworks`. |

No actions, evaluators, routes, or events are registered.

The overlay UI surface (registered via `src/register.ts` side-effect):

| Export | Description |
|--------|-------------|
| `wifiApp` | `OverlayApp` descriptor (name, displayName, category: "system", androidOnly: true). |
| `registerWifiApp()` | Registers `wifiApp` with `@elizaos/ui`'s overlay app registry. Called automatically on elizaOS Android. |
| `WifiAppView` | React component. Full-screen overlay: shows connected network, scans for nearby networks, connects/disconnects with optional password entry. |

## Layout

```
src/
  index.ts              Public barrel — re-exports everything below
  plugin.ts             appWifiPlugin: Plugin — registers wifiNetworks provider
  register.ts           Side-effect entry — calls registerWifiApp() if isElizaOS()
  ui.ts                 UI barrel — re-exports WifiAppView + wifi-app helpers
  providers/
    networks.ts         wifiNetworksProvider — calls WiFi.listAvailableNetworks, limit 25
  components/
    wifi-app.ts         wifiApp OverlayApp descriptor + registerWifiApp()
    WifiAppView.tsx     Full-screen React overlay UI (scan, connect, disconnect)
assets/
  hero.png              App catalog hero image
```

## Commands

```bash
bun run --cwd plugins/plugin-wifi typecheck   # tsgo type-check only (no emit)
bun run --cwd plugins/plugin-wifi lint        # biome check src/
bun run --cwd plugins/plugin-wifi test        # vitest run
bun run --cwd plugins/plugin-wifi build       # tsup + tsc declarations → dist/
bun run --cwd plugins/plugin-wifi clean       # rm -rf dist
```

## Config / env vars

No env vars or settings keys. The plugin reads no process environment at runtime. `@elizaos/capacitor-wifi` talks directly to the Android WifiManager via Capacitor; Android `ACCESS_FINE_LOCATION` permission must be granted at the OS level for scans to succeed.

## How to extend

**Add a provider:** Create `src/providers/<name>.ts` exporting a `Provider` object, then add it to the `providers` array in `src/plugin.ts`. Re-export it from `src/index.ts`.

**Add an action:** Create `src/actions/<name>.ts` exporting an `Action` object. Add an `actions` array to `appWifiPlugin` in `src/plugin.ts` and push the new action into it. Re-export from `src/index.ts`.

**Add a service:** Create `src/services/<name>.ts` extending `Service`. Register it in `appWifiPlugin.services`. Ensure it is exported from `src/index.ts`.

## Conventions / gotchas

- **Android-only.** `WifiAppView` and `registerWifiApp()` are safe to import on non-Android platforms but `@elizaos/capacitor-wifi` methods will reject or return empty results everywhere except Android. The `register.ts` entry guards registration behind `isElizaOS()`.
- **No server routes.** `WifiAppView` owns all its data by calling the Capacitor plugin directly; there is no backend API involved.
- **Scan limit.** `wifiNetworksProvider` caps at 25 networks; `WifiAppView` caps its own scan at 50. Keep these consistent if raising the limit.
- **Location permission.** Android requires `ACCESS_FINE_LOCATION` for `WifiManager.startScan`. If the permission is denied, scans succeed silently with an empty list or throw; the provider maps errors to `wifiNetworksError` in `values`.
- **Provider context gate.** `wifiNetworksProvider` uses `contextGate: { anyOf: ["system"] }` — it only fires in system-context conversations, not every agent turn.
- **`elizaos.app` metadata.** `package.json` carries an `elizaos.app` block (`displayName: "WiFi"`, `category: "system"`, `androidOnly: true`, `heroImage: "assets/hero.png"`) used by the app catalog tooling.
- **Root AGENTS.md.** Repo-wide architecture rules, logger conventions, ESM requirements, and naming rules live in the root `AGENTS.md`. This file covers only plugin-wifi specifics.

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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
