# Issue #13581 — Android assistant-role / voice-IME automated regression lane

## What this delivers (Done-when item 1 — the automated repeatable device lane)

`packages/app/scripts/android-assistant-ime-lane.mjs` + `test:android:assistant-ime`.

An **adb-driven** lane that works on a **retail/sideload** build — unlike
`ElizaOsInstrumentedTest`, which is `assumeSystemEliza()`-gated and assume-skips
vacuously off `/system/priv-app/`. Because every `adb install -r` clears the
assistant role and the enabled/selected IME, the lane (run after install):

1. re-applies the ASSISTANT role + the Eliza voice IME
   (`cmd role add-role-holder android.app.role.ASSISTANT ai.elizaos.app`,
   `ime enable` / `ime set`);
2. asserts the secure settings landed (`settings get secure
   voice_interaction_service` references the app; `default_input_method` is the
   Eliza IME) — an unset (`null`) / foreign value is a hard FAIL;
3. fires `cmd voiceinteraction show` + `input keyevent KEYCODE_ASSIST`;
4. asserts via logcat + `dumpsys activity` that the voice-session deep-link
   (`elizaos://voice?source=android-assistant-session`) routed into
   `MainActivity` — not swallowed as a silent no-op.

Returns a structured result (never throws on assertion failure), so a
deliberate regression **canary** (rename the VIS service → the secure setting
goes `null`) turns the lane red deterministically.

## Test evidence (real run on this host)

Command construction + settings/logcat/dumpsys parsing are pure functions with
an injectable `exec`, unit-tested without a device:

```
$ bunx vitest run packages/app/scripts/android-assistant-ime-lane.test.mjs
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Covers: exact role/IME adb arg vectors; `-s <serial>` prefixing + serial-required
guard; secure-setting pass on a referencing value and FAIL on `null`/empty/foreign;
`sessionLanded` requires deep-link AND MainActivity; full `runLane` pass; the
**canary** (renamed VIS → red); and the silent-no-op case (assist key fires but
the deep-link never reaches MainActivity → red).

## Acceptance criteria mapping

- ✅ item 1 (partial): an automated, repeatable adb lane that re-applies role+IME,
  asserts the secure settings, fires assist + `KEYCODE_ASSIST`, and asserts the
  session/deep-link lands in MainActivity — logic unit-verified above.
- ✅ item 3 (CI wiring): `:app:connectedDebugAndroidTest` is **already** wired into
  `native-plugin-androidtest` on develop (`android-device-e2e.yml:358`); this lane
  adds the retail-path (non-`assumeSystemEliza`) coverage that job was missing.
- ⏳ Live acceptance (green lane run on an arm64 emulator/device with screenrecord
  + logcat + the asserted-settings JSON; canary turns it red) — **needs a real
  Android emulator/device**, which this headless host lacks → Needs-agent-verify.

## Scoped follow-ons (NOT in this PR — need a device/engine)

- item 2: full-engine IME ASR round-trip (real mic-path WAV → `/api/asr/local-inference`
  → committed text), or assert the designed ENGINE_OFF state when the engine is absent.
- item 4: #12393 hardware assistant-key remap — implement in the vendor tree with a
  cuttlefish/Pixel verification step, or re-open as its own tracked issue.

## N/A with reason

- Live emulator/device run + screenrecord/logcat artifacts — **N/A here**: no
  Android emulator or device on this headless host. Proven by the 8-test contract
  suite + inspection; the live run is the device-lane verification step.
