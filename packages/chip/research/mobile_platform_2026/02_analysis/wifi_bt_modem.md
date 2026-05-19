# Wi-Fi 7, Bluetooth 6.0, 5G Modem Reality

Date: 2026-05-19

## Wi-Fi 7 (IEEE 802.11be)

### Spec highlights

- **320 MHz channel width** in 6 GHz band (AFC-controlled in US).
- **4K-QAM** (4096-QAM) modulation, 20% PHY-rate uplift vs 11ax 1024-QAM.
- **Multi-Link Operation (MLO)** — simultaneous transmit/receive across two
  bands (e.g. 5 GHz + 6 GHz) for latency and throughput.
- **Preamble puncturing** — better channel use under partial interference.
- **Restricted Target Wake Time (R-TWT)** — deterministic XR/AR scheduling.

### Open Wi-Fi 7 driver state (2026)

- **MediaTek mt76 / mt7996** — mainline-supported Wi-Fi 7 driver for MT7996
  (AP-class) and recent MT7925 / MT7927 (client-class). This is the **only
  Wi-Fi 7 driver path with serious open mainline support** as of 2026.
- **Broadcom BCM4398 / BCM4399** — Wi-Fi 7 client chips, no open driver
  upstream; Cypress fork via `brcmfmac` lags behind upstream Wi-Fi 7.
- **Qualcomm WCN7850 / FastConnect 7900** — closed-source; `ath11k` /
  `ath12k` cover earlier generations only.
- **Realtek RTL8922 / RTL8852C** — partial open driver via `rtw88` /
  `rtw89`; Wi-Fi 7 features incomplete.

### E1 contract today

`docs/arch/wifi.md` commits to an **external SDIO Wi-Fi + UART BT module**
(Murata Type 1DX / CYW4343W class). This is **Wi-Fi 5 + BT 5**, not Wi-Fi 7.
The E1 SoC does not bond Wi-Fi pins today and the SDIO host controller is
not implemented. Wi-Fi 7 upgrade requires a different module class — most
realistic open path is **PCIe-attached mt7925 / mt7927 M.2 module** rather
than SDIO, because Wi-Fi 7 throughput exceeds SDIO 3.0 bandwidth.

## Bluetooth 6.0

- **BT Core 6.0** (Q4 2024) — Channel Sounding (HADM ranging), enhancements
  to LE Audio, improved isochronous channels.
- **LE Audio + Auracast** (BT 5.2+ but mainstreamed in 6.0) — LC3 codec,
  broadcast isochronous streams. Hardware path: BT controller must expose
  Isochronous Channels (ISO) per HCI; firmware must implement BIS / CIS
  state machines.
- **Audio Sharing / Auracast Receivers** — phone is a BIS source or sink.

### Open BT 6.0 state

- **BlueZ + ELL** — Linux BT stack supports LE Audio LC3 since v5.66 (2023).
- **Channel Sounding (HADM)** — only emerging silicon (Nordic nRF54L,
  Silicon Labs EFR32xG24). No phone-class controller with mainline open
  drivers as of 2026.
- **Murata Type 1DX / CYW4343W** committed in `docs/arch/wifi.md` is **BT 5.0
  only** — does not support LE Audio's full feature set or Channel Sounding.

## 5G modem reality

### 3GPP releases

- **Rel-17** (frozen 2022) — RedCap (NR-Light), NR-NTN, sidelink relays,
  XR enhancements.
- **Rel-18** (frozen 2024) — 5G-Advanced: AI/ML for air interface, MBS,
  XR enhancements, NR-NTN expansion, expanded V2X.
- **Rel-19** (frozen 2025-2026) — 6G groundwork, AI-native air interface,
  Ambient IoT, MIMO enhancements.

### Open 5G stacks

- **OpenAirInterface (OAI)** — most complete open 5G NR codebase. gNB-side is
  field-deployable; UE-side requires SDR (USRP/SDR-class radios) and is
  **not a phone-class modem**. Useful for lab interop.
- **srsRAN Project** — Open RAN focused, gNB-first. UE side is limited.
- **Free5GC / Open5GS** — open 5G core network (5GC) — orthogonal to modem
  silicon.

### Commercial 5G modems for an open phone

- **Quectel RM520N-GL** — M.2 5G modem, USB 3.x + PCIe. **Closed firmware**
  but `qmi_wwan` + `modemmanager` provide an open host-side driver path.
- **Sierra EM7565 / EM9291** — same closed-firmware/open-host pattern.
- **Telit FN980m / FN990** — same pattern.
- **Qualcomm X75 / X80** discrete modems — closed; OEM only.

### Reality for E1

A **fully open 5G modem on E1 die is not realistic** in any 2026 horizon.
The realistic path is **external M.2 5G modem** (Quectel/Sierra class)
attached via USB or PCIe, controlled by ModemManager on Linux. This mirrors
the PinePhone Pro (Quectel EG25-G LTE) and Librem 5 (PLS8-X LTE) approach.

For E1 v0, **defer 5G entirely**. Wi-Fi-only is a defensible v0 target.
Adding LTE (not 5G) via an external USB modem post-v0 is a low-risk path.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| SDIO host controller | `rtl/io/e1_sdio_host.sv` | Missing |
| BT UART transport | `rtl/io/e1_uart.sv` (HCI) | Partial (no HCI binding) |
| Bonded WiFi/BT pins | `package/e1-demo-pinout.yaml` | Not bonded |
| WiFi module datasheet binding | `package/wifi/murata-1dx-sdio.yaml` | Scaffold only |
| Linux `brcmfmac` board file | board DTS | Missing |
| Wi-Fi 7 path (PCIe + mt7925) | `rtl/io/e1_pcie_host.sv` + DT | Far out |
| 5G modem path | External M.2 USB/PCIe | Out of scope for v0 |

## High-confidence recommendations

1. **Hold the line on Murata 1DX / CYW4343W class Wi-Fi 5 + BT 5 for v0.**
   Do not chase Wi-Fi 7 / BT 6 / 5G in v0 — every one of those requires
   different attach (PCIe), different module class, and different driver
   stack.
2. **Implement SDIO host RTL before any Wi-Fi claim moves.** This is the
   blocking RTL gap. Mirror existing open SDIO host IPs (e.g. PicoRV SDIO,
   Litex SDIO) as starting points.
3. **Bond Wi-Fi/BT pins in a successor padframe.** The current QFN64 demo
   pinout does not have room for the full WiFi external interface — this is
   a packaging step, not just an RTL one.
4. **Defer 5G modem to a post-v0 external M.2 path.** Document the path,
   don't build it.
