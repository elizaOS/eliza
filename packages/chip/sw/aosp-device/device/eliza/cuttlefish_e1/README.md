# cuttlefish_e1 device overlay

Layered device fragment that adds the Eliza e1 NPU **software-simulator**
HAL to a Cuttlefish `aosp_cf_riscv64_phone-*` build. The overlay does
not define its own lunch target; instead, Task 28's build script
(`sw/aosp-device/build-aosp-riscv64.sh`) inherits this product into the
Cuttlefish phone product when building for `vsoc_riscv64`.

## What lands in the Cuttlefish image

| Artifact | Path |
|---|---|
| Sim HAL binary | `/vendor/bin/hw/vendor.eliza.e1_npu@1.0-service.sim` |
| Sim HAL init rc | `/vendor/etc/init/vendor.eliza.e1_npu@1.0-service.sim.rc` |
| VINTF fragment | `/vendor/etc/vintf/manifest/vendor.eliza.e1_npu@1.0-service.sim.xml` |
| SELinux fragment | `/vendor/etc/selinux/vendor_sepolicy.cil` (merged) |

The HAL binary registers the `vendor.eliza.e1_npu@1.0::IE1Npu/default`
service exactly like the on-silicon HAL. `lshal -i` therefore reports
the same service name on Cuttlefish.

## What it does NOT do

- Define a new lunch target. Cuttlefish keeps using
  `aosp_cf_riscv64_phone-*`.
- Replace the on-silicon HAL. The simulator binary has the `.sim`
  suffix; both can coexist in a tree.
- Add camera/audio/radio/GNSS/NFC/bluetooth/wifi HALs. Cuttlefish
  already provides those; we only add `vendor.eliza.e1_npu`.

## Why a separate overlay

The on-silicon `eliza_ai_soc` product expects the real HAL pointed at
`/dev/e1-npu`. The sim HAL is only correct under Cuttlefish where the
char device does not exist. Keeping the overlays separate keeps both
paths fail-closed: the on-silicon path refuses to fall back to a
software fake, and the Cuttlefish path does not claim hardware
acceleration.
