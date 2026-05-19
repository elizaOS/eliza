# HALs and Mainline Drivers for Eliza E1

Date: 2026-05-19. Upstream driver and HAL options behind each contract
device named in `docs/arch/android-contract.md`.

## Display: simpledrm -> KMS path

- Eliza E1's "Display: framebuffer + vsync registers" contract maps to
  `simple-framebuffer` DT node (`compatible = "simple-framebuffer"`) plus
  the `simpledrm` mainline driver.
- This gives DRM/KMS, Android `drm_hwcomposer`, SurfaceFlinger, Mesa
  software / virgl, all without a custom GPU driver. It is the same
  path used by VisionFive 2 before vendor PowerVR userspace exists.
- For Cuttlefish RV64 the path is `virtio-gpu` (host) + `drm/virtio_gpu`
  (guest) + virgl userspace. This is the path the gate's
  `cuttlefish_riscv64_smoke.log` needs to exercise.

### Open GPU options if Eliza E1 ever absorbs a GPU IP

| IP | Mainline open driver | State | Notes |
| --- | --- | --- | --- |
| ARM Mali Midgard/Bifrost | drm/panfrost + Mesa panfrost | production | Mali T6xx-G7xx |
| ARM Mali Valhall (G610+)| drm/panthor + Mesa panthor | maturing | needed for new Mali |
| Vivante GC2000-GC7000 | drm/etnaviv + Mesa etnaviv | production | Verisilicon IP |
| Imagination PowerVR (Series 6+) | drm/img-rogue out-of-tree | research | StarFive uses this |
| Qualcomm Adreno (a3xx-a7xx) | drm/msm + Mesa freedreno | production | Qualcomm-tied |
| Broadcom VideoCore | drm/v3d + Mesa v3d | production | Raspberry Pi |

For an open RV64 mobile SoC with no existing GPU vendor relationship,
Mali Bifrost (panfrost) and Vivante (etnaviv) are the only stacks where
the entire userspace + kernel + Mesa stack is open today. Adopting either
means lifting their kernel driver into the BSP plus pulling Mesa into the
AOSP `external/mesa3d` build.

## Camera: V4L2 + libcamera + Android camera HAL

- Mainline path: `media-controller` graph -> sensor subdev driver ->
  MIPI CSI-2 RX (`drivers/media/platform/<vendor>/`) -> ISP -> V4L2 video
  node. libcamera userspace converts V4L2 to a vendor-agnostic API; the
  Android `camera.provider@2.x` HIDL (deprecated) or AIDL (preferred)
  HAL adapts libcamera to AOSP.
- For Cuttlefish RV64 the gate-listed `peripherals/rear_camera_sim.log`
  uses the virtual sensor backed by `crosvm` virtio-video; that path
  satisfies the `FRAME_SOURCE=simulated_sensor` marker in
  `aosp-simulator-completion-gate.yaml`.

## USB: dwc3 + USB-C role switch

- `drivers/usb/dwc3/dwc3-of-simple.c` is the bring-up vehicle for the
  DesignWare USB3 IP used by most RV SoCs (StarFive, T-Head, Andes).
- USB-C role switching via `extcon` + `usb-role-switch`.
- Android requires both host (for accessories, mass storage in dev mode)
  and gadget (adb, USB audio out, USB mass storage) modes.

## Storage: SD / eMMC / UFS

- Mainline: `sdhci-of-dwcmshc` for Synopsys DesignWare MSHC SD/eMMC
  controller; supports HS400 eMMC.
- UFS: `drivers/ufs/host/ufs-mediatek.c`, `ufs-qcom.c`, generic
  `ufshcd-pltfrm.c`. UFS UniPro driver in mainline. For Eliza E1 today
  SDHCI is the right minimum; UFS is the 2028 product upgrade path.
- RPMB (Replay-Protected Memory Block) is mandatory for AVB rollback
  index storage; `drivers/mmc/core/block.c` exposes /dev/mmcblkXrpmb.

## Networking: Wi-Fi + BT

- Wi-Fi: `mac80211` + `cfg80211` + `nl80211` kernel stack. Userland:
  `wpa_supplicant` for STA, `hostapd` for AP. Open drivers in mainline:
  iwlwifi (Intel), ath9k/ath10k/ath11k/ath12k (Qualcomm Atheros, open
  but vendor-tied), brcmfmac (Broadcom FullMAC), mt76 (MediaTek), rtw88/
  rtw89 (Realtek), mwifiex (NXP/Marvell).
- Open mobile-grade Wi-Fi options for an RV reference platform: ath11k
  (Qualcomm WCN6750/QCA6390 PCIe / SDIO), mt76 (MT7921/7922 PCIe),
  rtw88 (RTL8822CS SDIO).
- BT: BlueZ on Linux; Android Gabeldorsche on AOSP. HCI transport via
  UART/USB/PCIe. The `peripherals/bluetooth_sim.log` gate marker
  `HCI_ATTACH=pass` covers exactly the BlueZ/Gabeldorsche bring-up step.

### Android Wi-Fi HAL and supplicant

- Android `wifi`, `wifi.supplicant`, `wifi.hostapd` HALs are AIDL
  `@VintfStability` from Android 13+. The vendor HAL converts AOSP IPC
  to wpa_supplicant control sockets / nl80211 events. Reference
  implementation at `hardware/interfaces/wifi/`.

### Android Bluetooth HAL

- AIDL `android.hardware.bluetooth` v1; vendor implements `IBluetoothHci`
  which opens an HCI transport (UART, USB, vsock). Cuttlefish uses
  rootcanal (`packages/modules/Bluetooth/tools/rootcanal`) over vsock.

## Cellular (optional, gate-listed)

- AOSP cellular goes through `android.hardware.radio` AIDL plus a vendor
  RIL daemon (ofono, libqmi, libmbim adapters). For Cuttlefish the gate
  marker `LTE_REGISTRATION=pass / NR5G_REGISTRATION=pass` is provided
  by the Cuttlefish modem simulator (`packages/services/Telephony`'s
  test modem). Eliza E1 reuses this stub before any real modem IP.

## Power HAL 4.x (AIDL)

- `android.hardware.power@4` interfaces:
  - `IPower::setMode(Mode, enabled)` for app launch, audio streaming,
    sustained perf, fixed perf, etc.
  - `IPower::isModeSupported(Mode)` for vendor advertised modes.
  - `IPower::createHintSession(...)` for ADPF (Android Dynamic
    Performance Framework): per-process target work duration that the
    vendor HAL maps to CPU/GPU/NPU DVFS hints.
- Linux side: schedutil cpufreq governor + Energy Model + EAS. For
  big.LITTLE / DynamIQ-style heterogeneous CPUs (or AP + management
  cluster on Eliza E1) EAS picks the cheapest cluster per task.
- DT bindings: `operating-points-v2`, `cpu-supply`, optional
  `clock-latency-ns`.

## Thermal HAL 2.x (AIDL)

- `android.hardware.thermal@2` reports per-zone temperature and
  throttling state. Vendor maps to `thermal_zone*` sysfs + `cooling
  device` framework on Linux.
- Linux side: `drivers/thermal/` per-vendor sensor driver, governor
  (step_wise, power_allocator, bang-bang). Hardware sensors come up
  via I2C, on-die TS, or PMIC.

## eBPF and Tracing

- Android uses BPF heavily for netd, time-in-state, sched tracking. On
  RV64 the JIT is mature (see `linux_riscv_state.md`). Perfetto's
  ftrace + bpf paths work on Cuttlefish RV64; the only blocker is
  Sscofpmf for hardware-counter perf events.

## What this means for Eliza E1

1. The `docs/arch/android-contract.md` mapping is correct: framebuffer
   first, GPIO/I2C sensor hub second, DMA-style storage third. Each row
   has a mainline driver path. The implementation work is wiring the
   `sw/platform/generated/e1-platform.dtsi` to those drivers and to the
   AOSP HAL configs in `e1_platform_hal.json`.
2. Display: target `simple-framebuffer` first. Do not add a GPU IP to
   E1 in 2026; let SurfaceFlinger + drm_hwcomposer + Mesa software /
   virgl carry the bring-up while GPU IP selection runs on its own
   research track.
3. Wi-Fi/BT: target a PCIe/SDIO module with a known mainline driver
   (ath11k or mt76 or rtw88) instead of a custom radio IP. This keeps
   the gate-listed `wifi_sim.log` / `bluetooth_sim.log` markers achievable
   without owning a baseband.
4. Storage: SDHCI/dwcmshc + RPMB is sufficient. Postpone UFS.
5. Power/Thermal HAL: implement the AIDL services on top of `cpufreq-dt`
   + `thermal_zone` sysfs first, with a thin Eliza vendor adapter. Do
   not invent a parallel DVFS API.
6. NPU HAL: see `ai_accelerator_hal.md`.
