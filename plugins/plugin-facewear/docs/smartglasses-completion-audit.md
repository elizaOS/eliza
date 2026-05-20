# Smartglasses Completion Audit

This audit tracks the requested Even Realities smartglasses objective against
current repository evidence. It is intentionally stricter than the software
test suite: the goal is not complete until real hardware evidence proves the
physical microphone and tap path.

## Requirements

| Requirement | Evidence | Status |
| --- | --- | --- |
| Pull the 12 requested upstream repositories into a gitignored research folder. | `.gitignore` ignores `research/even-realities/`; `docs/upstream-audit.md` lists all 12 local checkouts and reviewed files. | Complete |
| Review upstream command, display, BLE, bridge, and simulator behavior. | `docs/upstream-audit.md` maps each upstream source to implemented files and tests. | Complete |
| Implement `plugins/plugin-facewear`. | `src/index.ts`, `src/protocol/smartglasses.ts`, `src/services/smartglasses-service.ts`, `src/actions/*.ts`, `src/providers/status.ts`, and `src/transport/*.ts`. | Complete |
| Stream and format display text properly. | `src/protocol/smartglasses.ts` implements G1 glyph-width wrapping, page/chunk encoding, Even AI and Text Show modes, and RSVP display; covered by `src/__tests__/protocol.test.ts` and example smokes. | Complete |
| Receive microphone data. | Direct G1 LC3 packets and bridge PCM/LC3/transcript events are handled in `SmartglassesService` and transports; covered by service, bridge, package, runtime, and parser tests. | Software-complete |
| Side tap enables/disables microphone input. | `SmartglassesService` maps single tap/long press to right-lens mic enable and double tap/stop recording to mic disable; covered by service and example tests. | Software-complete |
| Connect the whole headset, not a single lens. | Web Bluetooth, Noble, Bleak, bridge, and View Manager flows require left and right lens records; validators reject missing lens evidence. Web Bluetooth rejects visible side mismatches and duplicate device IDs during picker flow so a wrong or repeated lens selection cannot satisfy whole-headset pairing. Public Web Bluetooth and Noble whole-headset `connect()` calls clean up partial connections on failure. Native bridge status exposes both virtual lens records when the bridge is connected. | Software-complete |
| Provide an Eliza View Manager view for connect/test/setup. | `src/index.ts` declares `views` and app nav tabs; `src/register.ts` registers `/apps/smartglasses`; `src/ui/SmartglassesView.tsx` implements connect, diagnostics, Wi-Fi bridge, and guided validation; `packages/app-core/src/registry/entries/plugins/smartglasses.json` launches the internal tab and advertises whole-headset pairing, side-tap mic control, and Wi-Fi provisioning; `bun run --cwd plugins/plugin-facewear verify:app` covers app registry and registration tests. | Complete |
| Support iOS, Android, desktop setup paths where possible. | View Manager setup copy and transports cover native bridge, Web Bluetooth, Noble/Bleak, and EvenHub/Mentra bridge APIs. Bridge-backed Wi-Fi now supports scan/status/configure plus Mentra-style native `requestWifiSetup(reason)` setup prompts for hosts that expose a setup flow instead of direct credentials. Direct G1 BLE Wi-Fi provisioning remains unverified upstream and is bridge-only. | Complete with documented Wi-Fi limit |
| Add an example in `packages/examples`. | `packages/examples/smartglasses` contains package/runtime/simulator/browser/Noble/Bleak smokes, validation helpers, and docs. | Complete |
| Test with Eliza end to end. | `bun run --cwd packages/examples/smartglasses verify:software` passed on 2026-05-20 05:18:34Z: example lint/tests, Bleak parser test, plugin build, typecheck, public package smoke, AgentRuntime smoke, and simulator display/tap automation. `bun run --cwd plugins/plugin-facewear lint && bun run typecheck && bun run test && bun run verify:app` passed on 2026-05-20 05:19:01Z. Follow-up setup UX, registry metadata, hardware-proof script cleanup, Web Bluetooth side-mismatch/duplicate-device hardening, whole-headset partial-connect cleanup, bridge lens status reporting, structured agent-facing setup guidance in status/control results, and structured CLI hardware status readiness passed `bun run --cwd packages/examples/smartglasses lint`, `typecheck`, `test`, `smoke:package`, `hardware:status-latest`, `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, and `verify:app` by 2026-05-20 05:43:59Z. The final status-report cleanup passed `bun run --cwd packages/examples/smartglasses lint`, `test`, `typecheck`, and `hardware:status-latest`, plus `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, and `verify:app` on 2026-05-20 05:48:02Z. Native bridge Wi-Fi setup prompt support passed `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, `bun run --cwd packages/examples/smartglasses lint`, `test`, `typecheck`, `smoke:package`, `smoke:runtime`, and `hardware:status-latest` on 2026-05-20 05:54:21Z. Pushed bridge Wi-Fi status coverage and the View Manager transcript type guard passed `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, `bun run --cwd packages/examples/smartglasses test`, `typecheck`, and `hardware:status-latest` on 2026-05-20 06:19:34Z. View Manager native Wi-Fi scan/status normalization and bridge-method precedence coverage passed `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, `build`, `verify:app`, plus `bun run --cwd packages/examples/smartglasses test` and `typecheck` on 2026-05-20 06:28:38Z. A focused re-check passed `bun run --cwd plugins/plugin-facewear lint`, `typecheck`, `test`, `bun run --cwd packages/examples/smartglasses hardware:status-latest`, and `git diff --check` on 2026-05-20 06:32:10Z. Hardware proof freshness tooling passed focused example tests/typecheck and a fresh `hardware:bleak` attempt refreshed `/tmp/smartglasses-hardware-report-latest.json` on 2026-05-20 06:38:56Z. A follow-up no-lens scan classification pass on 2026-05-20 07:15:59Z passed `bun run --cwd packages/examples/smartglasses test`, `bun run --cwd plugins/plugin-facewear test`, and plugin typecheck. Shared hardware blocker classification for status and validation passed example tests/lint/typecheck on 2026-05-20 07:23:28Z. Noble native-binding failure reporting passed example tests/lint on 2026-05-20 07:27:30Z. Bleak final-status normalization and parser coverage passed example tests/lint/parser checks on 2026-05-20 07:32:55Z. Bleak discovered-device scan inventory passed example tests/lint/parser checks and refreshed the latest report on 2026-05-20 07:38:42Z. Bleak UART-service candidate matching passed example tests/lint/parser checks and refreshed the latest report on 2026-05-20 07:42:53Z. | Software-complete |
| Prove physical hardware tap and microphone path. | Earlier `/tmp/smartglasses-hardware-report-latest.json` from 2026-05-20 06:38:56Z connected both lenses and observed serial `S110LABC040019`, 17 writes, 14 parsed events, init/display/settings responses, heartbeat packets, and a right-lens mic-disable response, but no physical-state packet, taps, right-lens mic-enable write, or audio. A Noble attempt from 2026-05-20 07:26:42Z wrote a fresh report but failed before scanning because the native Noble binding is unavailable for the current macOS ARM64 Node/Bun ABI, reported as `physicalBlocker: "transport_unavailable"`. The freshest Bleak attempt from 2026-05-20 07:42:31Z found 36 BLE devices but zero Even/G1 name matches and zero Nordic UART-service candidates, so it reports `physicalBlocker: "headset_not_found"` with `status.connected: false`, no serial, no writes, no taps, and no audio. | Blocked on physical headset advertising/availability |

## Hardware Completion Gate

Completion requires a hardware report that passes:

```bash
bun run --cwd packages/examples/smartglasses hardware:validate-latest
```

For the final physical attempt, the latest-report proof helpers run the smoke,
print the status summary even on failure, then invoke the validator:

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:noble
```

The report must include:

- left and right lens connection records
- final service status with both lenses connected
- connection-ready/init writes
- display writes
- serial request and observed serial response
- settings writes
- `wearing` physical state
- single-tap or long-press mic-enable event
- right-lens `0x0E 0x01` mic-enable write
- non-empty right-lens microphone audio
- double-tap or stop-recording mic-disable event
- right-lens `0x0E 0x00` mic-disable write
- final service status audio counters

The current latest report from 2026-05-20 07:42:31Z is fresh, and CoreBluetooth
is scanning: it discovered 36 BLE devices, but zero matched Even/G1 names and
zero advertised the G1 UART service UUID. It therefore did not discover either
lens, and `hardware:status-latest` summarizes it with
`wholeHeadsetConnected: false`, `wearingReady: false`, and
`physicalBlocker: "headset_not_found"`. The previous Noble report from
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
bun run --cwd packages/examples/smartglasses hardware:bleak:latest
bun run --cwd packages/examples/smartglasses hardware:validate-latest
```

```bash
bun run --cwd packages/examples/smartglasses hardware:bleak:watch
```

or the full watch proof wrapper:

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:noble:watch
```
