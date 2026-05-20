# Storage: UFS 4.1, eMMC 5.1, Open UFS Host

Date: 2026-05-19

## UFS 4.1 (JEDEC JESD220G)

UFS 4.1 is the current production phone-class storage standard:

- **Two-lane M-PHY 5.0**, HS-Gear5 at ~23.2 Gbps/lane = ~5.8 GB/s peak.
- **UniPro layer** above M-PHY for link management.
- **UFS Transport (UFSHCI 4.0)** at the host controller level.
- **Power-save Hibern8 / DeepStall** for phone power management.
- **HPB (Host Performance Booster)** uses host DRAM for L2P map caching.
- **Write Booster** uses SLC region for burst writes.

UFS 4.0 (2022) and UFS 4.1 (2024) are widely shipped. UFS 5.0 is in the
JEDEC pipeline but not productized.

### Components needed for UFS in a SoC

1. **UFSHCI host controller** (digital, register-mapped) — translates AHCI/
   SCSI-like commands to UniPro packets.
2. **UniPro layer** (digital state machine) — link / segment / data link.
3. **M-PHY 5.0** (mixed signal) — 8b/10b encoding (or 64b/66b for Gear5),
   reference clock, equalizer. **This is the silicon-hard part.**
4. **Power islands + reset/wake sequencing** integrated with PMIC.

### Open UFS host IP

- **OpenCores `ufshc`** — sparse academic UFS host controller project; not
  silicon-proven and not maintained. Useful only as a structural reference.
- **Linux `drivers/ufs/host/`** — UFSHCI host driver covering Qualcomm,
  MediaTek, Renesas, Exynos, Tegra UFS controllers. Open driver side, but
  the host controllers themselves are closed silicon.

There is **no production-ready open-source UFS host controller IP** as of
2026. The M-PHY 5.0 in particular has no open implementation — it requires
analog design and tape-out experience that no open project has accumulated.

## eMMC 5.1

eMMC 5.1 (JEDEC JESD84-B51) is the legacy phone storage path. HS400 reaches
400 MB/s. Open eMMC host controllers exist (`dwcmshc`, `sdhci-*`) with full
mainline support. eMMC is the realistic E1 v0 storage path because:

- The same SDIO/SD host controller (SDHCI) handles eMMC at MMC-5.1 speeds.
- The required RTL is well-precedented (Designware mobile-storage host has
  multiple open clones).
- The PHY is much simpler — LVCMOS at 1.8 V, no M-PHY.

## NVMe over PCIe

Laptop-class storage path. Requires:

1. PCIe Gen 3/4 root complex (RC) on die.
2. NVMe SSD controller on the SSD side (commodity).

For a phone-class E1, NVMe is overkill in cost/area and PCIe RC is a large
RTL/PHY project. Not the right v0 path.

## E1 contract today

There is **no storage host controller** in the E1 RTL today. `package/e1-demo-pinout.yaml`
does not bond UFS or eMMC pins. Storage is implicit in `docs/architecture-optimization/phone-platform.md`
("storage" as a coupled platform system, no concrete contract).

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| eMMC host (SDHCI) RTL | `rtl/io/e1_sdhci.sv` | Missing |
| eMMC bonded pins | `package/e1-demo-pinout.yaml` MMC entries | Not bonded |
| UFS host controller | Out of scope for v0 | N/A |
| M-PHY 5.0 | Out of scope for v0 | N/A |
| Linux `mmc` driver binding | board DTS | Missing |
| Android storage HAL | Vold + StorageManager | Missing |

## High-confidence recommendations

1. **eMMC 5.1 is the v0 storage path.** SDHCI-class host controller is
   well-precedented in open RTL (Litex SDHCI, OpenCores SDHC). Author
   `rtl/io/e1_sdhci.sv` + cocotb when storage moves off "phone-platform.md"
   coupling.
2. **UFS 4.1 is post-v0.** Document the gap (M-PHY 5.0 missing in open
   ecosystem) and pin the v1 storage decision to either licensing a
   commercial M-PHY or staying on eMMC indefinitely.
3. **Author `package/storage/v0-emmc.yaml`** binding a concrete eMMC part
   (e.g. Samsung KLM8G1GETF-B041, Kioxia THGAMUG6T13BAIL) to the eMMC pin
   group when those pins are bonded.
4. **Defer NVMe / PCIe storage** until PCIe RC exists for other reasons
   (Wi-Fi 7, GPU). Not justified on storage alone.
