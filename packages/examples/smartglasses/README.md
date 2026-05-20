# Smartglasses Example

This example exercises `@elizaos/plugin-facewear` without physical glasses by using the plugin's mock transport. It validates the same G1 packet path used by the runtime service:

- display text is pixel-wrapped with the G1 glyph width profile, chunked into G1 `0x4E` display packets, and sent to both lenses in both Even AI and direct Text Show modes
- RSVP word-group display is exercised through the same G1 display packet path
- microphone enable and disable commands are sent to the right lens as `0x0E`
- side tap events toggle microphone state
- bridge-backed Wi-Fi scan/status/configure/setup-prompt actions are exercised
  through the mock transport path used by Eliza actions
- direct G1 microphone chunks are exposed as raw LC3 audio metadata with sequence tracking, and the mock example injects a decoder hook to exercise PCM callback delivery
- EvenHub/G2 bridge microphone chunks are exposed as 16 kHz PCM when the bridge supplies PCM audio events
- host STT/local transcription events are emitted as Eliza `SMARTGLASSES_TRANSCRIPT` events and included in status output
- manual-mode page up/down plus brightness, dashboard height/depth position, dashboard layout/content, navigation packets, translation overlays, head-up angle, silent mode, wear detection, lens-specific, iOS official same-init, and Android F4 same-init connection-ready packets, native function exit, serial request/response parsing, app whitelist/setup, raw packet writes, notes, voice-note list/fetch/delete/delete-all, generated 1-bit BMP, and notification packets are exercised
- managed heartbeat start/stop and explicit battery status requests are exercised as G1 connection-health paths

Run:

```bash
bun run --cwd packages/examples/smartglasses start
```

For the canonical software proof from the repository root, run:

```bash
npm run verify:smartglasses-software
```

That command runs the Facewear plugin lint/typecheck/test/app-registration
gates, then this example's full software verification, repairs any Bun lockfile
churn back to `@elizaos/plugin-facewear`, and then reruns the Facewear consolidation audit,
Even Realities research audit self-test, Even Realities research audit, and
smartglasses completion self-test.

For the lower-level example-only software gate:

```bash
bun run --cwd packages/examples/smartglasses verify:software
```

To verify the plugin through its public package export:

```bash
bun run --cwd packages/examples/smartglasses smoke:package
```

This starts the exported plugin service class with a runtime-like mock,
invokes the exported display and microphone actions, reads the exported status
provider, and checks Eliza event emission for glass and audio events.

To verify registration through a real `AgentRuntime`, including the sample
character config in `character.json`:

```bash
bun run --cwd packages/examples/smartglasses smoke:runtime
```

This loads `@elizaos/plugin-facewear` into an `AgentRuntime`, starts the
plugin service with the mock transport, exercises display and microphone
actions, routes control actions including bridge Wi-Fi setup, checks side-tap
mic disable behavior, and reads the status provider.

For a physical Even G1 smoke test with Web Bluetooth:

```bash
npm run smartglasses:dev:hardware
```

```bash
bun run --cwd packages/examples/smartglasses dev:hardware
```

Then open `http://127.0.0.1:5178/hardware-smoke.html` in a browser with Web Bluetooth support. Use **Connect Headset** to select the left lens, then **Connect Headset Right** to select the right lens. Browsers require a fresh user gesture for each Web Bluetooth device prompt, so the page presents this as one whole-headset flow while still satisfying Chrome's picker rules. Use **Guided Tap + Audio Validation** to send display/settings packets and run the live evidence window: single tap to enable the microphone, speak until audio appears, then double tap to disable the microphone. The page keeps a missing-evidence checklist visible and exports the final report for independent validation.

For EvenHub/G2 simulator testing, run the example dev server and point the simulator at the EvenHub smoke page. The plugin's `EvenBridgeTransport` supports the simulator-style `sendStartUpPage`, `onEvenHubEvent`, and `audioControl` bridge surface; the simulator's automation port can then screenshot the glasses framebuffer and inject click/double-click input.

```bash
npm run smartglasses:dev:simulator
npm run smartglasses:simulator
```

```bash
bun run --cwd packages/examples/smartglasses dev:simulator
bun run --cwd packages/examples/smartglasses simulator
```

For an automated simulator run that starts Vite, boots the simulator, waits for the app readiness marker, checks the RGBA glasses framebuffer for lit pixels, and injects click/double-click input:

```bash
npm run smartglasses:smoke:simulator
```

```bash
bun run --cwd packages/examples/smartglasses smoke:simulator
```

To include simulator microphone delivery, pass an audio input device ID through
the same `--aid` path used by Even Dev. The smoke harness will open the bridge
microphone and wait for an `audioEvent.audioPcm` console event:

```bash
SMARTGLASSES_SIMULATOR_AUDIO_DEVICE="coreaudio:BuiltInMicrophoneDevice" bun run --cwd packages/examples/smartglasses smoke:simulator
```

For a physical Even G1 smoke test from Node/Bun through Noble:

```bash
bun run --cwd packages/examples/smartglasses hardware:noble
```

This scans for both lenses, writes init/serial/display/settings packets,
disables the right microphone, waits for the glasses to report `wearing`, then
waits for a single tap to enable the microphone, waits for speech audio, and
requires a double tap to disable the microphone. It exits non-zero if the
required wearing, tap, or audio evidence is not observed. It requires the
optional `@abandonware/noble` dependency, a native Noble build compatible with
the current runtime, and host BLE permissions. If Noble reports
`physicalBlocker: "transport_unavailable"` on macOS, use the Bleak/CoreBluetooth
smoke instead or rebuild the Noble native binding for this Node/Bun ABI.

If Noble's native binding is unavailable on macOS, use the Bleak/CoreBluetooth smoke:

```bash
python3 -m pip install --user 'bleak>=0.22'
SMARTGLASSES_REPORT_PATH=./smartglasses-hardware-report.json bun run --cwd packages/examples/smartglasses hardware:bleak
```

The Bleak smoke connects the same whole headset directly through macOS CoreBluetooth, writes init/serial/display/settings packets, waits for the glasses to report `wearing`, then waits for single tap, microphone audio, and double tap evidence using the same JSON report schema as the browser and Noble smokes. The glasses must be out of the charging cradle and worn for the tap and microphone checks; cradle/charging state packets alone do not satisfy hardware evidence. Use `SMARTGLASSES_INIT_MODE=official`, `lens-specific`, or `android-f4` to compare upstream init variants, `SMARTGLASSES_WEARING_TIMEOUT_MS=30000` to tune the pre-validation wearing wait, and `SMARTGLASSES_DIRECT_MIC_MS=15000` to open the right microphone directly before the tap-gated check.

For the final auditable hardware proof run, use the root latest-report helpers.
They write `/tmp/smartglasses-hardware-report-latest.json`, print a setup/status
summary even when the smoke fails, and then run the strict validator. The
validator requires the latest report to be fresh within ten minutes so an old
`/tmp` artifact cannot be reused as current proof.

Check current setup state first:

```bash
npm run smartglasses:hardware:doctor
npm run smartglasses:hardware:status
```

`smartglasses:hardware:status` is safe before the first proof run: if the
latest report does not exist yet, it still prints local Bluetooth adapter and
paired G1 lens state plus the next setup action.

Then run the default CoreBluetooth/Bleak proof:

```bash
npm run smartglasses:hardware:prove
```

Use Noble only when its native binding is compatible with the current runtime:

```bash
npm run smartglasses:hardware:prove:noble
```

If the short proof connects both lenses but does not observe wearing state, or
if the status summary reports `physicalBlocker: "headset_not_found"`, remove
both lenses from the charging base, wear them, keep them near this Mac, and run
the longer watch proof:

```bash
npm run smartglasses:hardware:prove:watch
```

The latest report includes `discoveredDevices`, `discoveredDeviceCount`, and
`discoveredG1DeviceCount` so failed scans can distinguish "BLE scanner saw
nothing" from "nearby BLE devices were visible, but no Even/G1 lenses were
advertising." The status summary also includes `scanDiagnosis`:
`no_ble_devices`, `ble_seen_no_g1_candidates`, `g1_candidates_seen`,
`left_lens_missing`, `right_lens_missing`, or `whole_headset_seen`. On macOS,
the Bleak report also records `bluetoothAdapter` and `pairedG1Devices` before
scanning, so a failed `/tmp` proof artifact can show whether both lenses were
paired but not advertising. Both `hardware:status-latest` and
`hardware:validate-latest` echo those fields when they are present in the report,
and include `bluetoothPreflightSource` to show whether the values came from the
report or a local fallback read.

Package-local equivalents are available when you are already working inside the
example:

```bash
bun run --cwd packages/examples/smartglasses hardware:doctor
bun run --cwd packages/examples/smartglasses hardware:status-latest
bun run --cwd packages/examples/smartglasses hardware:prove:bleak
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch
```

```bash
npm run smartglasses:hardware:prove:noble:watch
```

```bash
bun run --cwd packages/examples/smartglasses hardware:prove:noble:watch
```

Validate the fresh latest artifact independently before treating physical
hardware support as proven:

```bash
npm run smartglasses:hardware:validate
```

To leave an auditable JSON artifact from the Noble smoke, set
`SMARTGLASSES_REPORT_PATH`:

```bash
SMARTGLASSES_REPORT_PATH=./smartglasses-hardware-report.json bun run --cwd packages/examples/smartglasses hardware:noble
```

The report records connection-ready/init writes, serial request/response state,
display packet writes, side-tap microphone enable/disable state, raw audio
chunks with sequence metadata, latest physical/battery/device headset state,
and the final `SmartglassesService` status. Validation fails explicitly with
`headsetInCradle` and `wearingStateNotObserved` when the glasses are still in
the charging base or have not reported a worn state.
Validate the artifact independently with:

```bash
bun run --cwd packages/examples/smartglasses hardware:validate-report ./smartglasses-hardware-report.json
```
