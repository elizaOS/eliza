# USB and Type-C / PD Specification (v0)

Status: pre-silicon / pre-board specification. No USB controller is
selected. v0 explicitly does **not** claim USB-IF certification, the USB
Type-C logo, or USB Power Delivery compliance. This document records the
selection criteria and the explicit no-cert claim required by the
`security-usb-storage-update-fail-closed-work-order` evidence policy.

## 1. Scope and explicit non-claims

- v0 targets USB 2.0 device-mode (high-speed, 480 Mb/s) only.
- v0 does **not** ship as USB-IF certified; no "USB-C" trademark used.
- v0 does **not** ship USB-PD source mode. v0 is sink-only.
- v0 does **not** claim USB SuperSpeed (3.x), Thunderbolt, DisplayPort
  Alt-Mode, USB4, or audio Alt-Mode.
- These exclusions are recorded so that
  `release-claims_forbidden_until` in
  `docs/project/product-architecture-security-radio-sensors-optimization-2026-05-17.yaml`
  remains satisfied. Any change requires a separate work order with a
  USB-IF pre-scan or full certification record archived under
  `docs/manufacturing/evidence/usb-storage-update/usb-if/`.

## 2. USB 2.0 device controller selection criteria

| Criterion | Requirement | Rationale |
|---|---|---|
| Spec compliance | USB 2.0 high-speed (480 Mb/s) device class; suspend/resume; remote-wake optional. | Required by Android USB HAL for ADB/fastboot/MTP. |
| PHY | UTMI+ level 3 or ULPI; vendor-supplied; integrated termination calibration. | Avoids analog PHY design risk in v0. |
| Protocol stack | Linux Gadget Framework (`drivers/usb/gadget`) compatibility; ConfigFS. | Mainline support for `f_fs` (fastboot), `f_mtp`, `f_adb`. |
| Endpoints | >= 16 IN / 16 OUT endpoints, including >= 4 bulk pairs. | ADB + fastboot + MTP + future. |
| DMA | Scatter-gather DMA with bus-master access only to an isolated DMA region (see IOMMU policy in `arch/interconnect.md`). | Limits a malicious-host blast radius. |
| Reset behavior | Bus reset must not affect any non-USB clock/power domain. | Safe under hostile-host attach. |
| Charger detect | BC 1.2 DCP / CDP / SDP detect. | Battery management policy depends on this. |
| Open IP option | Prefer a controller with publicly available register documentation and open Linux driver. | Reproducibility; audit. |
| Licensing | No NDA-only driver; if vendor IP is closed, archive the binary blob hash in release manifest. | `docs/risks/risk-register.md` "Local fork drift" applies. |

## 3. Type-C connector and CC policy

| Item | v0 policy |
|---|---|
| Connector | USB Type-C receptacle (mechanical only — no USB-C logo claim). |
| Orientation detect | CC1/CC2 sensed by dedicated CC controller (external chip — see §4). |
| Data role | UFP (Upstream Facing Port — device only). DRP (dual-role) not supported in v0. |
| Power role | Sink only. Source mode disabled at PCB level (no VBUS source FET). |
| VCONN | Not supplied. Active cables not supported. |
| Try.SNK behavior | Not applicable — fixed UFP. |
| Audio Accessory Mode | Disabled. |
| Debug Accessory Mode | Disabled in production board variant; permitted only on dev-board variant with explicit jumper. |

## 4. PD policy (sink-only)

- PD controller candidates: vendor part with public TCPCI driver (e.g.,
  TCPCI-class device behind I2C). PD MCU vs. integrated TCPC selected based
  on BOM and firmware-update story.
- Sink PDOs advertised (initial set):
  - 5 V @ 3 A (15 W)
  - 9 V @ 2 A (18 W)
- The PD policy engine must:
  - Default to 5 V @ 500 mA SDP until PD negotiation completes.
  - Reject any source-cap that violates the platform input range
    (4.5 V-13 V; >13 V triggers OVP and disconnect).
  - Implement Hard Reset on protocol error.
  - Refuse to enter ANY alt-mode (DP, TBT, etc.).
- v0 explicitly does **not** ship a USB-PD compliance pre-scan transcript;
  any "PD ready" claim is forbidden until such a pre-scan is archived.

## 5. Current limits

| Path | Steady | Peak | Protection |
|---|---|---|---|
| VBUS in (sink) | 3 A @ 5 V (BC 1.2 DCP) or PD-negotiated | 3 A | OVP set 6 V (5 V mode) / 14 V (PD); OCP at 3.5 A; eFuse with auto-retry inhibit on persistent fault. |
| VBUS sense ADC | n/a | n/a | Bootloader and OS read with low-pass filter. |
| Internal 5 V rail | per system | per system | Independent of VBUS to allow hot-unplug. |

PCB design must reserve eFuse + TVS placement on the VBUS lane regardless
of charger-IC selection.

## 6. ESD and EMC strategy (no compliance claim)

- Connector pins protected by TVS array sized for IEC 61000-4-2 +/-8 kV
  contact / +/-15 kV air, per datasheet only — no IEC pre-scan in v0.
- CC1/CC2 lines protected by low-capacitance TVS (<= 1 pF) to preserve
  USB 2.0 eye.
- D+/D- pairs routed as 90-ohm differential; common-mode choke optional,
  fitted footprint by default.
- EMC pre-scan deferred to a separate work order; no FCC/CE claim in v0.

## 7. Fastboot / ADB integration (USB-side)

- ADB enumerates as a USB function backed by `f_ffs`; bound to userspace
  `adbd`.
- Fastboot enumerates as a separate USB function on the bootloader path; in
  `fastbootd` mode, it is `f_ffs` again with userspace `fastbootd`.
- USB enumeration is permitted in all lifecycle states; the lock policy is
  enforced inside the fastboot/ADB stacks per `avb-a-b-ota.md` §7, not by
  withholding USB enumeration.

## 8. Board work-order open questions

- Final TCPC selection (vendor + part number) and firmware-update channel.
- ESD reference design diff against vendor app note.
- VBUS eFuse part selection with auto-retry inhibit.
- Board layout for crosstalk between CC and D+/D-.
- Whether to populate a USB-C debug-accessory header on dev variant.

## 9. Cross-references

- `threat-model.md` mitigations M13, surface S8
- `avb-a-b-ota.md` §7 fastboot lock matrix
- `docs/project/product-architecture-security-radio-sensors-optimization-2026-05-17.yaml`
  `usb_storage_update_stack`
- `docs/risks/risk-register.md` "Drop-in flagship pin compatibility",
  "Local fork drift"
