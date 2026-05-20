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
| Implement `plugins/plugin-smartglasses`. | `src/index.ts`, `src/protocol.ts`, `src/services/smartglasses-service.ts`, `src/actions/*.ts`, `src/providers/status.ts`, and `src/transport/*.ts`. | Complete |
| Stream and format display text properly. | `src/protocol.ts` implements G1 glyph-width wrapping, page/chunk encoding, Even AI and Text Show modes, and RSVP display; covered by `src/__tests__/protocol.test.ts` and example smokes. | Complete |
| Receive microphone data. | Direct G1 LC3 packets and bridge PCM/LC3/transcript events are handled in `SmartglassesService` and transports; covered by service, bridge, package, runtime, and parser tests. | Software-complete |
| Side tap enables/disables microphone input. | `SmartglassesService` maps single tap/long press to right-lens mic enable and double tap/stop recording to mic disable; covered by service and example tests. | Software-complete |
| Connect the whole headset, not a single lens. | Web Bluetooth, Noble, Bleak, bridge, and View Manager flows require left and right lens records; validators reject missing lens evidence. Web Bluetooth rejects visible side mismatches and duplicate device IDs during picker flow so a wrong or repeated lens selection cannot satisfy whole-headset pairing. Public Web Bluetooth and Noble whole-headset `connect()` calls clean up partial connections on failure. Native bridge status exposes both virtual lens records when the bridge is connected. | Software-complete |
| Provide an Eliza View Manager view for connect/test/setup. | `src/index.ts` declares `views` and app nav tabs; `src/register.ts` registers `/apps/smartglasses`; `src/ui/SmartglassesView.tsx` implements connect, diagnostics, Wi-Fi bridge, and guided validation; `packages/app-core/src/registry/entries/plugins/smartglasses.json` launches the internal tab and advertises whole-headset pairing, side-tap mic control, and Wi-Fi provisioning; `bun run --cwd plugins/plugin-smartglasses verify:app` covers app registry and registration tests. | Complete |
| Support iOS, Android, desktop setup paths where possible. | View Manager setup copy and transports cover native bridge, Web Bluetooth, Noble/Bleak, and EvenHub/Mentra bridge APIs. Direct G1 BLE Wi-Fi provisioning remains unverified upstream and is bridge-only. | Complete with documented Wi-Fi limit |
| Add an example in `packages/examples`. | `packages/examples/smartglasses` contains package/runtime/simulator/browser/Noble/Bleak smokes, validation helpers, and docs. | Complete |
| Test with Eliza end to end. | `bun run --cwd packages/examples/smartglasses verify:software` passed on 2026-05-20 05:18:34Z: example lint/tests, Bleak parser test, plugin build, typecheck, public package smoke, AgentRuntime smoke, and simulator display/tap automation. `bun run --cwd plugins/plugin-smartglasses lint && bun run typecheck && bun run test && bun run verify:app` passed on 2026-05-20 05:19:01Z. Follow-up setup UX, registry metadata, hardware-proof script cleanup, Web Bluetooth side-mismatch/duplicate-device hardening, whole-headset partial-connect cleanup, bridge lens status reporting, structured agent-facing setup guidance in status/control results, and structured CLI hardware status readiness passed `bun run --cwd packages/examples/smartglasses lint`, `typecheck`, `test`, `smoke:package`, `hardware:status-latest`, `bun run --cwd plugins/plugin-smartglasses lint`, `typecheck`, `test`, and `verify:app` by 2026-05-20 05:43:59Z. The final status-report cleanup passed `bun run --cwd packages/examples/smartglasses lint`, `test`, `typecheck`, and `hardware:status-latest`, plus `bun run --cwd plugins/plugin-smartglasses lint`, `typecheck`, `test`, and `verify:app` on 2026-05-20 05:48:02Z. | Software-complete |
| Prove physical hardware tap and microphone path. | Latest `/tmp/smartglasses-hardware-report-latest.json` from 2026-05-20 05:22:44Z connects both lenses and observes serial `S110LABC040019`, 17 writes, 24 parsed events, init/display/settings responses, state packets, heartbeat packets, and a right-lens mic-disable response. It still reports `charged_in_cradle` / `cradle_fully_charged`, no tap events, no right-lens mic-enable write, and no right-lens audio. | Blocked on physical worn-state evidence |

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

The current latest report from 2026-05-20 05:22:44Z proves direct BLE
connectivity and command/response coverage: both lenses are connected
(`Even G1_51_L_138507` and `Even G1_51_R_8C0CDF`), serial `S110LABC040019`
is observed, 17 writes and 24 parsed events are recorded, and event types
include `init`, `serial`, `display-result`, `settings-response`, `state`,
`mic-response`, and `heartbeat`. A fresh short `hardware:bleak` run reconfirmed
this on 2026-05-20 05:22:44Z, and `hardware:status-latest` summarized it
again on 2026-05-20 05:48:02Z with `wholeHeadsetConnected: true`,
`wearingReady: false`, `physicalBlocker: "in_charging_base"`, and a setup hint
that asks for both lenses to be removed from the charging base and worn. The
headset state is `charged_in_cradle` / `cradle_fully_charged`, so it still fails
the physical portion of the gate: `headsetInCradle`, `wearingStateNotObserved`,
missing tap events, missing right-lens mic-enable write, and missing right-lens
audio. Remove the glasses from the charging base, wear them, then run
the latest helper and perform single tap, speech, and double tap:

```bash
bun run --cwd packages/examples/smartglasses hardware:bleak:latest
bun run --cwd packages/examples/smartglasses hardware:validate-latest
```
