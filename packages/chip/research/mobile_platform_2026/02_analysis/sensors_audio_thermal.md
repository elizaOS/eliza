# Sensors, Audio Subsystem, Thermal, Antenna

Date: 2026-05-19

## Sensor suite

A modern Android-class phone exposes the following sensors with mainline
Linux + Android Sensor HAL support:

### IMU (motion)

- **Bosch BMI323** — 6-axis IMU, 16 kB FIFO, gesture engine, I2C/I3C/SPI.
  Mainline `drivers/iio/imu/bmi323/`. Phone-class default.
- **Bosch BMI270** — also widely used; mainline.
- **STMicro LSM6DSV16X** — 6-axis IMU + on-chip "machine learning core"
  for activity/gesture classification. Mainline `drivers/iio/imu/st_lsm6dsx/`.
- **InvenSense / TDK ICM-42688P** — 6-axis IMU, very low noise. Mainline.

### Pressure / barometer

- **Bosch BMP390 / BMP581** — pressure + temperature. Mainline.
  Used for floor-level altitude in indoor nav.

### Magnetometer

- **AKM AK09915 / AK09918** — 3-axis magnetometer. Mainline.
- **Bosch BMM150** — 3-axis. Mainline.

### Ambient light + proximity

- **AMS TSL2591 / TSL2540** — ALS + proximity. Mainline.
- **STMicro VL53L8** — multi-zone ToF (4x4 / 8x8 zones), 16 Hz.

### Time-of-flight (dToF/iToF for AF)

- **AMS TMF8828** — dToF ranging for camera autofocus. Mainline driver
  partial (manual binding).
- **STMicro VL53L5CX** — phone-class dToF.

### Fingerprint (under-display)

- Closed silicon ecosystem. Goodix, FocalTech, Egis dominate. **No open
  driver path.** Open phones either omit fingerprint or use a side-button
  capacitive sensor (e.g. Cirrus Logic / Synaptics with closed firmware).
- A side-mounted **Synaptics FS92xx** or **Goodix GF95xx** is the most
  realistic option, accepting closed firmware and Android `fingerprint@2.x`
  HAL closed implementation.

### Secure element / SE-attached fingerprint

- **NXP A71CH / SE050** — open-driver secure element (ECC P-256 / RSA-2K).
  Mainline I2C driver.
- Phone-class fingerprint with SE-bound templates is an Android security
  requirement — no open phone has shipped this end-to-end.

## Audio subsystem

### Topology

I2S/TDM/PCM bus from SoC → audio codec → speakers/headphones/mics.

```
[ AP I2S TX/RX ]  <---->  [ Audio codec (DAC/ADC) ]  <---->  [ Smart amp ] -> speaker
                                  |
                                  +-->  [ Headphone jack / USB-C audio ]
                                  +-->  [ MEMS mic array (PDM) ]
```

### Codec ICs (open driver path)

- **TI TLV320AIC3204 / TAS2781** — TI audio codec + smart amp. Mainline
  ASoC driver.
- **Realtek ALC5686 / ALC5688** — phone/tablet codec. ASoC driver in mainline.
- **Cirrus Logic CS35L41 / CS35L45** — smart amplifier + haptic driver
  used in many Android flagships and Apple devices. Mainline ASoC.
- **Wolfson / Cirrus WM8960 / WM8994** — legacy but solid ASoC support.
- **NXP TFA9890 / TFA9874** — smart amp. Partial ASoC.

### MEMS microphones

- **Knowles SPH0641LM4H / SPH0655LM4H** — PDM MEMS mic, phone-class.
- **InvenSense ICS-43434** — PDM MEMS, dual-mode (analog + PDM).
- **STMicro MP34DT06J** — PDM MEMS, used in array beamforming.

A phone-class mic array is typically **3-4 PDM mics** for beamforming and
noise rejection. PDM clocks at 3.072 MHz, decoded by the SoC's PDM input
block (or via the codec's PDM input).

### Open audio DSP

- **PipeWire + WirePlumber** — userspace audio policy on Linux. Replaces
  PulseAudio for Wayland phones.
- **AOSP `audioserver` + Tinyalsa** — Android-side. Tinyalsa is the
  open-driver-friendly userspace shim.
- **DSP firmware** — closed for Qualcomm aDSP / MediaTek MDP; open route
  is **CPU-side audio processing** (no DSP) or a small RISC-V audio core
  with open firmware (e.g. SiFive E21 / Caliptra-class core for audio).

## Thermal management

### Phone-class thermal stack

1. **Die-level TIM** (thermal interface material) between die back-side
   and IHS (integrated heat spreader) inside the package.
2. **Package-level TIM** between IHS and a graphite spreader or vapor
   chamber on the board.
3. **Graphite heat spreader** — Laird, Henkel, Panasonic PGS / EYG graphite
   sheets, 0.025-0.07 mm thick, in-plane k = 1500-1800 W/m-K.
4. **Vapor chamber** — Forcecon, Auras, AVC make phone-class VCs
   (0.3-0.8 mm thick, 30-60 mm long). Effective k = 5000-10000 W/m-K
   in-plane.
5. **Gap-filler pads** (Bergquist Gap Pad, 3M, Henkel) — fill air gaps
   between VC and chassis / back glass.

### Realistic open-phone thermal

- Vapor chamber is fab-supplied as a sealed unit; phone OEMs purchase
  rather than build. Sourcing a phone-class VC (30-60 mm) is feasible from
  Forcecon / Auras at small quantities.
- DIY VC is **not realistic** at phone form factor — the sintered-copper
  wick + working fluid charge process is industrial.
- **Graphite + gap-filler** is the achievable open-phone thermal stack.
  Effective for ~2-4 W sustained.

For E1 at ~6-10 W sustained NPU + AP loads, vapor chamber is needed.
PinePhone Pro at ~3-5 W sustained uses graphite + gap-filler only.

## Antenna

### Phone antenna placement

- **Main cellular (sub-6 GHz)**: PIFA at top/bottom edges of phone, length
  ~quarter-wave at lowest band (~700 MHz / ~10 cm).
- **Wi-Fi/BT (2.4/5/6 GHz)**: smaller PIFA, often in side rail. 2.4 GHz
  needs ~3 cm.
- **GPS / GNSS (1.575 GHz)**: typically a separate ceramic chip antenna
  or a multi-band PIFA.
- **NFC (13.56 MHz)**: loop antenna under the back cover, around the
  battery.
- **UWB (6.5-8 GHz)**: ceramic chip antenna; only on flagships.
- **mmWave (24-40 GHz)**: phased-array module integrated into the side
  rails. Out of scope for E1 — no open mmWave path.

### Antenna design tools

- **`openEMS`** — open FEM/FDTD solver for antenna simulation.
- **`NEC2` (with `xnec2c` GUI)** — wire-antenna code; useful for PIFA
  prototyping.
- Closed: ANSYS HFSS / CST Microwave Studio.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| Sensor hub I2C/I3C path | `rtl/io/e1_i2c.sv` host | Partial / missing |
| Audio codec I2S path | `rtl/io/e1_i2s.sv` host | Partial / missing |
| PDM mic input | `rtl/io/e1_pdm_in.sv` | Missing |
| Sensor selection | `package/sensors/<parts>.yaml` | Missing |
| Codec selection | `package/audio/<codec>.yaml` | Missing |
| Antenna placement plan | `docs/board/antenna-plan.md` | Missing |
| Thermal stack | `docs/board/thermal-stack.md` | Missing |

## High-confidence recommendations

1. **Pick mainline-supported sensors only.** BMI323 (IMU) + BMP390
   (baro) + AK09918 (mag) + TSL2591 (ALS/prox) covers the v0 sensor
   suite with mainline drivers.
2. **Pick a mainline codec.** Realtek ALC5688 or TI TLV320AIC3204 +
   Cirrus CS35L41 smart amp.
3. **Pick PDM MEMS mics from Knowles SPH06xx family.** Two-mic array
   minimum for noise rejection.
4. **Graphite + gap-filler thermal for v0.** Vapor chamber after
   silicon power data exists.
5. **Defer fingerprint / NFC / UWB / mmWave to post-v0.**
