# Open Phone Platforms — Lessons for E1

Date: 2026-05-19

## Reference platforms

### Pine64 PinePhone Pro (2022-)

- **SoC**: Rockchip RK3399S (2x A72 + 4x A53, Mali-T860, RGA, VPU).
- **PMIC**: Rockchip RK809 (companion charger PMIC also).
- **Wi-Fi/BT**: AP6256 SDIO + UART (Murata-class) — almost exactly the
  contract in `docs/arch/wifi.md`.
- **Modem**: Quectel EG25-G LTE M.2-ish module on USB 2.0.
- **Display**: 6" 720x1440 IPS DSI, plain DSI (no DSC).
- **Camera**: OV13855 + OV5640 (open V4L2 driver path).
- **Storage**: 128 GB eMMC 5.1 + microSD.
- **PCB**: hand-routable 6-layer; full schematic and Gerbers public.
- **Open OS**: Mainline Linux, postmarketOS, Manjaro Phosh, Mobian.

**Lessons for E1**:

- Almost every E1 contract (DA9063/RK809-class PMIC, SDIO Wi-Fi + UART BT,
  DSI panel, eMMC, external LTE modem) maps directly onto a PinePhone Pro
  shape. The Pro is the closest realistic open precedent.
- Camera tuning is the visible weak spot — open ISP + open IPA in libcamera
  is not at parity with closed Qualcomm/MediaTek stacks. E1 should adopt
  PinePhone-class expectations (functional, not flagship).

### Purism Librem 5 (2019-)

- **SoC**: NXP i.MX8M Quad (4x A53, GC7000Lite GPU, VPU, ISP).
- **PMIC**: TI BD71837 (mainline) + companion charger.
- **Wi-Fi/BT**: Redpine RS9116 (M.2 card) — physical isolation kill switch.
- **Modem**: Gemalto/Thales PLS8-X LTE M.2.
- **Display**: 5.7" 720x1440 IPS DSI.
- **Storage**: eMMC 5.1.
- **Open hardware**: Schematic + layout public via Purism repos.
- **OS**: Pure OS (Debian + Phosh).

**Lessons for E1**:

- M.2 form factor for modem/Wi-Fi is the right modular path — keeps RF
  silicon and certification off the AP board.
- Hardware kill switches require dedicated GPIO routing; budget pins.
- i.MX8M Plus would be a closer SoC reference (it has ISP). i.MX8M Quad in
  Librem 5 does not, which is why their camera story is weak.

### Nothing Phone (1)/(2)/(3a)

- **SoC**: Qualcomm Snapdragon 7+ Gen 2 / Snapdragon 8s Gen 3 / Dimensity
  7350 Pro. Closed reference.
- **Display**: LTPO OLED 6.55-6.7", DSI-2 + DSC 1.2a.
- **Camera**: Sony LYT-700 + Samsung JN1 (closed driver paths).
- **Notable**: "Glyph" rear-LED matrix as the most copyable open-design
  idea — a separately-driven LED matrix over I2C, not a phone-platform
  blocker.

**Lessons for E1**:

- A "design-forward" phone is built on stock Qualcomm/MediaTek today; no
  open phone is at parity with Nothing on industrial design.
- Glyph-class accent LEDs are within reach of an E1 GPIO/PWM block.

### MNT Pocket Reform (2024-)

- **SoC**: NXP i.MX 8M Plus on a swappable SoM module (also Rockchip RK3588
  variant).
- **PMIC**: Onboard companion PMIC; SoM owns its own AP rails.
- **Form**: Handheld with full keyboard, not strictly a phone — but the
  **SoM-on-mainboard architecture is the right model** for an open
  E1 platform.
- **Open hardware**: Full KiCad sources public.

**Lessons for E1**:

- SoM/mainboard split lets the SoC team iterate on E1 silicon without
  forcing the phone enclosure team to re-spin. This is the realistic
  decoupling for a small team.

### EOMA68 (2014-2020, mostly historical)

- Standardized SoM card carrying SoC + PMIC + RAM + Flash + Wi-Fi.
- **Lesson**: Standardization slows iteration; useful for hobbyist swap
  but not the right shape for an E1 generation transition.

### FairPhone 5 (2023-)

- **SoC**: Qualcomm QCM6490 (industrial Snapdragon 7c+ Gen 3) — uniquely
  long support window (8+ years).
- **Modular repair**: Camera/USB/battery/display all replaceable with #00
  screws and FFC connectors.
- **Lessons for E1**: Modular FFC connector strategy is the right approach
  for any open phone — display, camera, battery all on FFC cables, not
  soldered directly. Service window matters more than spec.

## Common open-phone failures (anti-patterns to avoid)

1. **Custom PMIC** — every open phone that built a custom PMIC stalled.
   Use mainline-supported off-the-shelf PMICs.
2. **Custom modem firmware** — no open project has shipped an open phone
   modem. Always external M.2 closed modem.
3. **Custom Wi-Fi firmware** — same story. Brcmfmac / mt76 with vendor
   firmware blobs is the working pattern.
4. **Custom camera ISP without tuning data** — the ISP gates work but the
   tuning package gates *quality*. PinePhone camera UX is the visible
   evidence.
5. **Custom enclosure with custom thermal** — vapor chamber DIY is
   feasible but graphite + gap-filler TIM is more achievable for small
   teams.

## High-confidence recommendations for E1

1. **Adopt the PinePhone Pro architectural shape as v0 baseline.** Same
   PMIC class, same SDIO Wi-Fi + UART BT, same DSI panel class, same
   eMMC storage, same external LTE modem option.
2. **Adopt MNT Pocket Reform SoM split.** E1 lives on a SoM; phone
   mainboard handles PMIC, USB-C/PD, FFC connectors, sensors.
3. **Adopt Fairphone modular FFC strategy.** Display, camera, battery,
   button-PCB all on FFC cables.
4. **Do not invent new modem, PMIC, or Wi-Fi paths.** Use existing
   mainline-supported parts.
