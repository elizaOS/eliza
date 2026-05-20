# Smartglasses Completion Audit

This audit tracks the requested Even Realities smartglasses objective against
current repository evidence. It is intentionally stricter than the software
test suite: the goal is not complete until real hardware evidence proves the
physical microphone and tap path.

## Requirements

| Requirement | Evidence | Status |
| --- | --- | --- |
| Pull the 12 requested upstream repositories into a gitignored research folder. | `.gitignore` ignores `research/even-realities/`; `docs/smartglasses-upstream-audit.md` lists all 12 local checkouts and reviewed files. | Complete |
| Review upstream command, display, BLE, bridge, and simulator behavior. | `docs/smartglasses-upstream-audit.md` maps each upstream source to implemented files and tests. | Complete |
| Implement `plugins/plugin-facewear`. | `src/index.ts`, `src/protocol/smartglasses.ts`, `src/services/smartglasses-service.ts`, `src/actions/*.ts`, `src/providers/smartglasses-status.ts`, and `src/transport/*.ts`. | Complete |
| Stream and format display text properly. | `src/protocol/smartglasses.ts` implements G1 glyph-width wrapping, page/chunk encoding, Even AI and Text Show modes, and RSVP display; covered by `src/__tests__/protocol-smartglasses.test.ts` and example smokes. | Complete |
| Receive microphone data. | Direct G1 LC3 packets and bridge PCM/LC3/transcript events are handled in `SmartglassesService` and transports; covered by service, bridge, package, runtime, and parser tests. | Software-complete |
| Side tap enables/disables microphone input. | `SmartglassesService` maps single tap/long press to right-lens mic enable and double tap/stop recording to mic disable; covered by service and example tests. | Software-complete |
| Connect the whole headset, not a single lens. | Web Bluetooth, Noble, Bleak, bridge, and View Manager flows require left and right lens records; validators reject missing lens evidence. Web Bluetooth rejects visible side mismatches and duplicate device IDs during picker flow so a wrong or repeated lens selection cannot satisfy whole-headset pairing. Public Web Bluetooth and Noble whole-headset `connect()` calls clean up partial connections on failure. Native bridge status exposes both virtual lens records when the bridge is connected. | Software-complete |
| Provide an Eliza View Manager view for connect/test/setup. | `src/index.ts` declares Facewear and Smartglasses views and app nav tabs; `src/register.ts` registers `/apps/facewear` and `/apps/smartglasses`; `src/ui/SmartglassesView.tsx` implements connect, diagnostics, Wi-Fi bridge, and guided validation; exported diagnostics now include pairing `scanDiagnosis`, `physicalBlocker`, setup hint, next action, observed serial number, packet writes, and audio chunk metadata; `packages/app-core/src/registry/entries/plugins/facewear.json` launches the internal tab and advertises whole-headset pairing, side-tap mic control, and Wi-Fi provisioning; `bun run --cwd plugins/plugin-facewear verify:app` covers app registry and registration tests. | Complete |
| Support iOS, Android, desktop setup paths where possible. | View Manager setup copy and transports cover native bridge, Web Bluetooth, Noble/Bleak, and EvenHub/Mentra bridge APIs. Bridge-backed Wi-Fi now supports scan/status/configure plus Mentra-style native `requestWifiSetup(reason)` setup prompts for hosts that expose a setup flow instead of direct credentials. The Even Realities Android companion now scans for `_L_` and `_R_` lenses, connects the whole headset, uses current G1 command framing, and forwards `g1_raw`/`mic_lc3` events to the agent. Direct G1 BLE Wi-Fi provisioning remains unverified upstream and is bridge-only. | Complete with documented Wi-Fi limit |
| Add an example in `packages/examples`. | `packages/examples/smartglasses` contains package/runtime/simulator/browser/Noble/Bleak smokes, validation helpers, and docs. | Complete |
| Test with Eliza end to end. | `npm run verify:smartglasses-software` passed on 2026-05-20 after the Facewear build scripts were hardened to use the workspace `tsup` binary for `build:js` and stable `vite@7.2.7` for `build:views`. The root verifier now runs Facewear plugin lint/typecheck/test/app-registration gates, then the full smartglasses example software gate, repairs any Bun lock churn back to `@elizaos/plugin-facewear`, and reruns the consolidation, Even research self-test, Even research audit, and completion self-test guards before the completion gate is evaluated. `bun run --cwd plugins/plugin-facewear test` passed with all 20 plugin test files / 185 tests, including view bundle build and CLI emulator build before Vitest. `bun run --cwd packages/examples/smartglasses verify:software` passed end to end: example lint, Bun tests, protocol tests, Bleak parser test, hardware doctor syntax check, dependency-aware Turbo typecheck, public package smoke, AgentRuntime smoke with setup-friendly aliases, and simulator display/tap automation. `bun run --cwd packages/examples/smartglasses smoke:package` covers 92 mock whole-headset writes, including start AI, clear display, exit dashboard/function, side-specific page-up/page-down, silent mode, brightness, head-up angle, wear detection, app allowlist, notification, BMP transfer, Wi-Fi setup, navigation, translation, notes, display, mic, audio, transcript, and status provider assertions. The same software gate includes `hardware:test-doctor`, a non-hardware syntax check for the macOS Bluetooth/headset diagnostic, and its `typecheck` script builds Facewear dependencies through Turbo before invoking `tsc` so missing workspace declaration artifacts cannot hide dependency-resolution failures. `verify:app` passed with the Facewear app registration tests. The focused action tests prove display/microphone actions fail cleanly without transport, the control action returns structured operation results for invalid parameters and generated commands, package smoke verifies public action failure behavior plus G1 setup/navigation packet counts, and AgentRuntime smoke verifies display/mic return values, invalid control failure payloads, setup-friendly alias canonicalization, alias Wi-Fi requests, alias app allowlist packets, alias QuickNote packets, and previous/next-page alias packet routing. The standalone consolidation guard passed after lock repair and scanned 34,567 files across `packages`, `plugins`, `apps`, and `scripts`; the stale `plugin-smartglasses` spot check was empty after the repair, and the completion gate now also checks critical lockfile/manifest paths plus the stable Facewear build scripts. Earlier focused passes also covered Web Bluetooth side-mismatch/duplicate-device hardening, whole-headset partial-connect cleanup, bridge lens status reporting, View Manager diagnostics, Wi-Fi setup prompts, voice-note list/fetch/delete/delete-all, battery status, dashboard positioning, native Android bridge routing, package/runtime/simulator smokes, hardware doctor paired-but-not-advertising diagnosis coverage, ordered tap-to-mic hardware validator requirements, View Manager ordered tap-to-mic report requirements, and View Manager display packet sequencing. | Software-complete |
| Prove physical hardware tap and microphone path. | Earlier `/tmp/smartglasses-hardware-report-latest.json` from 2026-05-20 06:38:56Z connected both lenses and observed serial `S110LABC040019`, 17 writes, 14 parsed events, init/display/settings responses, heartbeat packets, and a right-lens mic-disable response, but no physical-state packet, taps, right-lens mic-enable write, or audio. A Noble attempt from 2026-05-20 07:26:42Z wrote a fresh report but failed before scanning because the native Noble binding is unavailable for the current macOS ARM64 Node/Bun ABI, reported as `physicalBlocker: "transport_unavailable"`. The freshest Bleak attempt from 2026-05-20 10:39:00Z found 30 BLE devices but zero Even/G1 name matches and zero Nordic UART-service candidates, so it reports `physicalBlocker: "headset_not_found"` with `status.connected: false`, no serial, no writes, no taps, and no audio. The hardware doctor confirms macOS Bluetooth is on and both lenses are paired (`Even G1_51_L_138507` and `Even G1_51_R_8C0CDF`) but listed under "Not Connected", so the remaining blocker is physical advertising/availability rather than software wiring. | Blocked on physical headset advertising/availability |

## Hardware Completion Gate

Completion requires a hardware report that passes:

```bash
npm run smartglasses:hardware:validate
```

For the final physical attempt, the latest-report proof helpers run the smoke,
print the status summary even on failure, then invoke the validator:

```bash
npm run smartglasses:hardware:prove
```

```bash
npm run smartglasses:hardware:prove:noble
```

The report must include:

- left and right lens connection records
- final service status with both lenses connected
- connection-ready/init writes
- display writes
- serial request and observed serial response
- settings writes
- `wearing` physical state
- single-tap or long-press mic-enable event followed by a right-lens `0x0E 0x01` mic-enable write
- non-empty right-lens microphone audio
- double-tap or stop-recording mic-disable event followed by a right-lens `0x0E 0x00` mic-disable write
- final service status audio counters

For consolidation checks that must not let Bun regenerate stale lock entries,
use the standalone Node guard. It recursively scans `packages`, `plugins`,
`apps`, and `scripts`, plus the root package manifest and lockfile:

```bash
npm run audit:facewear-consolidation:fix-lock
npm run audit:facewear-consolidation
npm run audit:facewear-consolidation:self-test
```

For upstream research evidence, use the standalone Node guard:

```bash
npm run audit:even-research
npm run audit:even-research:self-test
```

For a single completion gate that also inspects the latest physical report, use:

```bash
npm run audit:smartglasses-completion
npm run audit:smartglasses-completion:self-test
```

The current latest report from 2026-05-20 10:39:00Z refreshed the physical
proof attempt, but it now fails the completion gate with `reportStale`.
CoreBluetooth was scanning and discovered 30 BLE devices, but
zero matched Even/G1 names and zero advertised the G1 UART service UUID. It
therefore did not discover either lens, and `npm run smartglasses:hardware:status` summarizes
it with `wholeHeadsetConnected: false`, `wearingReady: false`, and
`physicalBlocker: "headset_not_found"`. The completion gate hardware summary
now also includes `pairedG1Devices`, `pairedG1DeviceCount`,
`pairedWholeHeadset`, and `bluetoothAdapter`; for older latest reports that
predate those fields, it augments the summary from the live macOS Bluetooth
inventory. The latest-report status and validator summaries also echo those
fields once the Bleak proof report contains them, and include
`bluetoothPreflightSource` to distinguish report data from local fallback data.
macOS Bluetooth system state still lists
both G1 lenses as paired (`Even G1_51_L_138507` and `Even G1_51_R_8C0CDF`), but
they are under "Not Connected"; `npm run smartglasses:hardware:doctor` reports this paired-but-not-
advertising state directly. A Noble report from
2026-05-20 07:26:42Z failed before scanning because the Noble native binding is
unavailable for the current runtime and reported
`physicalBlocker: "transport_unavailable"`. An earlier 2026-05-20 06:38:56Z
Bleak run
proved direct BLE connectivity and command/response coverage for both lenses
(`Even G1_51_L_138507` and `Even G1_51_R_8C0CDF`) and serial
`S110LABC040019`, but it is stale and did not observe `wearing`, tap events,
a right-lens mic-enable write, or right-lens audio. Remove both lenses from the
charging base, keep them near this device, wear the glasses until the report
shows `physical: "wearing"`, then perform single tap, speech, and double tap.
Use the watch helper for a longer discovery and worn-state window:

```bash
npm run smartglasses:hardware:prove
npm run smartglasses:hardware:validate
```

```bash
npm run smartglasses:hardware:prove:watch
```

or the full watch proof wrapper:

```bash
npm run smartglasses:hardware:prove:watch
```

```bash
npm run smartglasses:hardware:prove:noble:watch
```
