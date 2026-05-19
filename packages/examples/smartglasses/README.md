# Smartglasses Example

This example exercises `@elizaos/plugin-smartglasses` without physical glasses by using the plugin's mock transport. It validates the same G1 packet path used by the runtime service:

- display text is pixel-wrapped with the G1 glyph width profile, chunked into G1 `0x4E` display packets, and sent to both lenses in both Even AI and direct Text Show modes
- RSVP word-group display is exercised through the same G1 display packet path
- microphone enable and disable commands are sent to the right lens as `0x0E`
- side tap events toggle microphone state
- direct G1 microphone chunks are exposed as raw LC3 audio metadata with sequence tracking, and the mock example injects a decoder hook to exercise PCM callback delivery
- EvenHub/G2 bridge microphone chunks are exposed as 16 kHz PCM when the bridge supplies PCM audio events
- host STT/local transcription events are emitted as Eliza `SMARTGLASSES_TRANSCRIPT` events and included in status output
- manual-mode page up/down plus brightness, dashboard layout/content, navigation packets, translation overlays, head-up angle, silent mode, wear detection, lens-specific and official same-init connection-ready packets, native function exit, serial request/response parsing, app whitelist/setup, raw packet writes, notes, voice-note fetch/delete, generated 1-bit BMP, and notification packets are exercised
- managed heartbeat start/stop is exercised as the G1 connection-maintenance path

Run:

```bash
bun run --cwd packages/examples/smartglasses start
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

This loads `@elizaos/plugin-smartglasses` into an `AgentRuntime`, starts the
plugin service with the mock transport, exercises display and microphone
actions, checks side-tap mic disable behavior, and reads the status provider.

For a physical Even G1 smoke test with Web Bluetooth:

```bash
bun run --cwd packages/examples/smartglasses dev:hardware
```

Then open `http://127.0.0.1:5178/hardware-smoke.html` in a browser with Web Bluetooth support. Select the left lens first, then the right lens. The page sends connection-ready/init, serial request, display text, microphone enable/disable, and settings packets, then logs a structured evidence checklist for single-tap mic enable, double-tap mic disable, LC3 audio notifications, serial responses, and final service status.

For EvenHub/G2 simulator testing, run the example dev server and point the simulator at the EvenHub smoke page. The plugin's `EvenBridgeTransport` supports the simulator-style `sendStartUpPage`, `onEvenHubEvent`, and `audioControl` bridge surface; the simulator's automation port can then screenshot the glasses framebuffer and inject click/double-click input.

```bash
bun run --cwd packages/examples/smartglasses dev:simulator
bun run --cwd packages/examples/smartglasses simulator
```

For an automated simulator run that starts Vite, boots the simulator, waits for the app readiness marker, checks the RGBA glasses framebuffer for lit pixels, and injects click/double-click input:

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

This scans for both lenses, writes init/serial/display/settings packets, disables the right microphone, waits for a single tap to enable the microphone, waits for speech audio, then requires a double tap to disable the microphone. It exits non-zero if the required tap or audio evidence is not observed. It requires the optional `@abandonware/noble` dependency and host BLE permissions.

To leave an auditable JSON artifact from the Noble smoke, set
`SMARTGLASSES_REPORT_PATH`:

```bash
SMARTGLASSES_REPORT_PATH=./smartglasses-hardware-report.json bun run --cwd packages/examples/smartglasses hardware:noble
```

The report records connection-ready/init writes, serial request/response state,
display packet writes, side-tap microphone enable/disable state, raw audio
chunks with sequence metadata, and the final `SmartglassesService` status.
Validate the artifact independently with:

```bash
bun run --cwd packages/examples/smartglasses hardware:validate-report ./smartglasses-hardware-report.json
```
