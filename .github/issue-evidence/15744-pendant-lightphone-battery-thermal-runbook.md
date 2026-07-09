# Issue #15744 Pendant + Light Phone III Battery/Thermal Runbook

## What is known, and what is not

- Pendant cell installed for this program: **651723, 1S 3.7 V, 150 mAh**.
- The devkit firmware selects fast charge and documents it as **100 mA** in
  `omi/firmware/devkit/src/lib/battery/{battery.h,battery.c}`. That is about
  `0.67 C` for a 150 mAh cell. Confirm the cell datasheet and board charger
  limits before changing charge current.
- The same devkit source labels its voltage lookup as a **1S 250 mAh** discharge
  profile. That inherited comment/profile is not calibration evidence for the
  installed 150 mAh 651723 cell. A voltage percentage is also not a coulomb
  count, especially under microphone/radio load.
- The separate stock Omi firmware path contains a 150 mAh voltage profile, but
  that does not establish the eliza pendant v3 board's runtime either.
- **No physical full-discharge result is available in this lane.** Runtime is
  estimated only until the device owner completes the test below.

### Provisional runtime estimate

The only defensible capacity calculation is `runtime hours = usable mAh /
average load mA`. Average load has not been measured on this hardware. As a
sensitivity range, a 150 mAh cell at 20-50 mA average load is 3.0-7.5 ideal
hours, or roughly **2.5-6.5 hours** after a conservative 15% unusable/aging
margin. This is an engineering estimate, not a product claim. Replace it with
median measured runtime and range after at least three complete discharges.

Charging also needs measurement. `150 mAh / 100 mA = 1.5 h` is only the ideal
constant-current phase. The constant-voltage tail and charger termination make
real full-charge time longer. Do not publish 1.5 h as observed charge time.

## Ownership and collision rule

The physical pendant and LP3 are owned by the device/E2E lane. This performance
lane must not flash firmware, pair a second BLE central, reset the board, or
start a discharge while that lane is using the hardware. Prepare the commands,
then run only after explicit handoff. The read-only Bleak smoke utility is still
a competing BLE central and must not run while the LP3 is connected.

Record the handoff owner, UTC start/end, firmware commit/hash, APK hash/version,
cell label, charger/cable, ambient temperature, and whether the cell is new or
aged.

## A. Ten-minute LP3 walk, app drain and thermal

1. Charge the LP3 and pendant, disconnect both from USB, and let them rest 15
   minutes at room temperature.
2. Confirm the installed APK is the exact build under test. Keep normal radios
   and screen behavior documented. Do not enable airplane mode unless that is
   the intended product scenario.
3. Read and record pendant BAS percentage. Treat it as a trend only because the
   150 mAh discharge curve is not calibrated.
4. Connect the pendant from the LP3 and reach the listening state.
5. From this repository root, capture Android evidence:

```bash
APP_ID=ai.elizaos.app \
OUT=.github/issue-evidence/15744-pendant-lightphone-performance-android-walk \
DURATION_SECONDS=600 \
SAMPLE_INTERVAL_SECONDS=60 \
bash .github/issue-evidence/15744-pendant-lightphone-performance-android-walk.sh
```

6. Walk for ten minutes with representative speech, silence, screen-off time,
   reconnect once if that is part of the scenario, and no USB power.
7. At 0, 5, and 10 minutes record the pendant BAS percentage and pendant case
   temperature with the same IR thermometer/thermocouple location. Record
   ambient temperature. Do not infer pendant temperature from Android
   `thermalservice`; it reports LP3 sensors only.
8. Review `samples/`, before/after meminfo, LP3 battery/batterystats, thermal,
   CPU, Bluetooth/radio dumps, and filtered logcat. Confirm package identity and
   actual pendant traffic before interpreting deltas.

Report LP3 battery change as both percentage points and batterystats estimates.
A ten-minute integer percentage delta can quantize to zero or one point, so it
is directional evidence, not runtime proof. Report thermal status/sensor values,
not subjective words such as "cool".

## B. Pendant full-discharge runtime

Run at least three trials with the same firmware and workload:

1. Charge to charger termination, unplug, and rest 15 minutes.
2. Record open-circuit/start voltage if the device owner has a safe test point
   and approved high-impedance meter. Never probe or short the LiPo connector
   during an active shared-device session.
3. Start a monotonic timer when the LP3 reaches listening. Use a repeatable duty
   cycle, for example 5 minutes representative speech and 10 minutes silence,
   with the same reconnect policy and phone distance each trial.
4. Every 15 minutes record elapsed time, BAS percentage, link state, packet-loss
   counter, ambient temperature, and pendant case temperature. Video or a
   timestamped log is preferred over memory.
5. Stop on normal low-battery shutdown/disconnect, swelling, odor, charger or
   cell abnormality, or a case-temperature rise that violates the cell/board
   datasheet. Do not deep-discharge or repeatedly power-cycle at cutoff.
6. Recharge under observation and record time to charger termination. If a USB
   power meter is available, record input current/energy, but do not equate USB
   input mAh directly to cell capacity without conversion losses.

For each trial publish total runtime, reconnects, packet loss, temperature rise,
and workload. After three trials publish median, minimum, maximum, and the raw
log. Only then replace the provisional estimate.

## C. Optional read-only BLE smoke after LP3 handoff

After disconnecting the LP3 and receiving device-lane handoff, the firmware QA
utility can independently verify BAS/audio cadence for a short sample:

```bash
cd /mnt/HC_Volume_106234565/eliza-workers/omi-fw/omi
python3 omi/firmware/devkit/scripts/ble_smoke_eliza_pendant_v3.py \
  --adapter hci0 \
  --device AA:BB:CC:DD:EE:FF \
  --duration 10
```

Use the explicitly handed-off adapter/device. The utility subscribes to audio
and reads BAS; it does not flash or write application/control characteristics.
Disconnect it before returning hardware ownership to the LP3 lane.

## Acceptance evidence

- Exact firmware/APK identity and physical cell label recorded.
- Three raw full-discharge logs, no synthetic extrapolation presented as fact.
- Pendant case and LP3 sensor temperatures include ambient and measurement
  method.
- LP3 10-minute capture includes periodic meminfo/battery/thermal samples and
  relevant logcat.
- BAS curve mismatch (150 mAh installed versus inherited 250 mAh devkit comment)
  remains disclosed until the firmware/device lane supplies calibrated data.
