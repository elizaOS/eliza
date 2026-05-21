# E1 phone EVT0 mechanical concept — retail spec sheet

- Evidence class: `cad_estimate_for_evt_planning, not_measured_hardware`
- Source: `chip/mechanical/e1-phone/cad/e1_phone_params.yaml`
- Revision: evt0-mechanical-cad-bonded-display-thinned

## Mechanical
- Dimensions: 78.0 x 153.6 x 11.8 mm (fully flush flat back, no camera bump, no protruding lens ring)
- Envelope volume: 141.37 cm^3
- Corner radius: 7.5 mm
- Mass: 191.68 g reconciled (183.28 g CAD geometry + 8.4 g assembly-stage items); ship target 168 +/-10 g (FAIL). 185 g is the original aspirational concept target; 168 +/-10 g is the EVT0 ship target (158-178 g window). Flush-back rev (11.8 mm, 5727 mAh battery) reconciled CAD mass 191.68 g is FAIL against the ship-target window (over by 13.68 g). The CAD mass is a nominal-density geometry estimate, not measured hardware; the overage must be closed at EVT by measured component mass and/or mass-reduction before the ship target can be claimed. Aspirational concept target 185 g retained for reference.
- Color / material: hard safety orange / PC+ABS injection molded

## Display
- 5.5" IPS LCD, 1080x1920 FHD, MIPI DSI, capacitive multi-touch
- Cover glass: [77.1, 151.77, 0.7] mm
- Active area: [68.04, 120.96] mm

## Compute
- SoC class: Rockchip RK3566 (quad Cortex-A55, Mali-G52, 1 TOPS NPU)
- Module: Firefly Core-3566JD4-class System-on-Module (PATH A, default) bundling SoC + LPDDR4 + eMMC + PMIC behind a public 260-pin SODIMM pinout
- RAM: 2 GB LPDDR4 (on-module)
- Storage: 32 GB eMMC 5.1 (on-module; 64/128 GB option)
- OS: AOSP / Android 14
- Cost-down note: A bare-SoC path (bare Unisoc T606 / RK3566 + discrete LPDDR4/eMMC/PMIC, PATH B) is ~$4.55-7.10/unit cheaper but requires the SoC vendor NDA for the BGA ball-map.

## Cellular
- Modem: Quectel RG255C 5G RedCap LGA
- Bands (typical): n1, n3, n5, n8, n28, n40, n41, n77, n78
- Note: 5G RedCap (NR-Light); LTE fallback per module datasheet

## Wireless
- Module: Murata Type 2EA
- Wi-Fi: Wi-Fi 6E (2.4/5/6 GHz)
- Bluetooth: Bluetooth 5.3

## USB
- USB Type-C (GCT USB4105), USB 2.0, USB-PD 15 W wired
- Video out: False

## Battery & charging
- 5727 mAh @ 3.85 V = 22.05 Wh (LiPo pouch, LiPol LP566487 class 3.85 V 5727 mAh 22.05 Wh thick pouch)
- Wireless charging: False

## Audio
- Bottom speaker: 1115 micro speaker module
- Earpiece: 1206 receiver behind cover glass
- Microphones: 2x MEMS (bottom + top noise-cancel)
- Haptic: 0612 X-axis LRA

## Camera
- Rear: 13 MP OmniVision OV13855 autofocus, 1 lens (single)
- Rear flash: single rear torch/flash LED (Everlight/OSRAM-class ~1.0x1.0 mm) behind a flush light-pipe window, AW36515-class flash driver
- Front: 5 MP GalaxyCore GC5035 fixed-focus, 1 lens (single)

## Environmental
- IP rating (design intent): IP54 (dust-protected, splash-resistant)
- IP rating certified: False
- Reasoning: USB-C perimeter gasket + drip-break lip + drain shelf, labyrinth-sealed side buttons with elastomer gaskets, perimeter cover-glass adhesive bond, port mesh on acoustic openings. Sufficient for IP54 design intent; IP67 not claimed (no pressure-tested chassis seal).
- Drop target: 1.0 m on 6 faces (design target, not certified)

_All values are CAD-derived for EVT planning. No measured hardware. Mass, IP rating, and drop figures are design targets and require EVT/DVT verification._
