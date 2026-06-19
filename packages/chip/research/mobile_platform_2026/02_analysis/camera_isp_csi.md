# Camera: MIPI CSI-2, Open ISP, Image Sensors

Date: 2026-05-19

## Standards baseline

- **MIPI CSI-2 v4.0** is the current camera-interface contract. It adds Smart
  Region of Interest, RAW28, 4K/8K image transport, Always-On Sentinel Mode
  (always-on CV at low power), and Unified Serial Link. CSI-2 runs over either
  D-PHY (1-4 lanes) or C-PHY (1-3 trios) — the same PHY families as DSI, which
  is why the two interfaces share pad cells in production SoCs.
- **MIPI CCS** (Camera Command Set) is the standard sensor command/control
  abstraction over I2C/I3C. Linux v4l2-subdev expects CCS-compatible drivers.
- **MIPI I3C** is the modern sensor control bus replacement for I2C. Most
  modern phone sensors expose both I2C and I3C control paths.

## Phone sensor landscape (2026)

- **Sony LYTIA family** — LYT-900 (1" type, stacked CIS + DRAM), LYT-808, LYT-700,
  LYT-600. All are CSI-2 over D-PHY (4 lanes typical), Bayer + tetra-binning
  output. No open driver from Sony; integrators write `v4l2_subdev` drivers
  from the public CCS register map (NDA-gated in practice).
- **Samsung ISOCELL family** — HP9 (200 MP, tetra^2pixel), GN6, JN5. Similar
  closed-driver story; some drivers exist in Samsung's downstream kernel
  fork.
- **OmniVision** — OV50H, OV64B, OV13B. OmniVision tends to publish more of
  the register map and there are partial open drivers in mainline Linux for
  older OV5640 / OV13B class sensors. This is the most realistic path for an
  open phone build.
- **Sentinel / always-on sensors** — Himax HM01B0 / HM0360, ON Semi AR0144,
  STMicro VD55G1. Low-resolution, low-power CV sensors used for face-wake.

## Open ISP cores

- **`cruzerogh/openISP`** — algorithmic Python/C model of a full ISP pipeline
  (BPC, BLC, AAF, AWB, lens shading, demosaic, CCM, gamma, CFC, EE, NR, CSC).
  Useful as a software reference before RTL.
- **`openasic-org/openISP` (academic FPGA ISP)** — Verilog RTL Bayer-to-RGB
  pipeline (BLC, AWB stats, demosaic, CCM, gamma, YCbCr). 1080p60 target on
  mid-range FPGAs. Reasonable starting point for an E1 ISP gap-closer.
- **NXP i.MX 8M Plus ISP (public block diagram)** — vendor reference for a
  small phone-class ISP (12 MPx primary + 2 MPx HDR + WDR + denoise). Not
  open, but the block-level architecture is published.
- **Rockchip rkisp1 (kernel driver)** — one of the few **upstream Linux V4L2
  ISP drivers** with a fully open binding (`drivers/media/platform/rockchip/rkisp1`).
  The driver targets RK3399 / RK3326 / RV1126 ISPv1. Reading the kernel driver
  and DT bindings gives the cleanest open contract for what a V4L2 ISP must
  expose.

## libcamera + Android Camera HAL 3

The realistic open camera stack is **libcamera** (userspace) layered over
V4L2 subdevs (kernel). libcamera splits between:

- **Core pipeline handler** — open, in `src/libcamera/`.
- **IPA module** — image processing algorithm, often vendor-supplied; the
  open path uses the libcamera IPA stub or an in-tree open IPA.

For Android, libcamera has a Camera HAL 3 shim (`src/android/`). This is the
most realistic path for E1 Android camera bring-up.

## E1 contract today

Camera work is **fully blocked** per `docs/architecture-optimization/phone-platform.md`:

> Camera work is blocked on sensor selection, CSI, ISP ownership, tuning package,
> calibration records, privacy indicator policy, and HAL or V4L2 transcripts.

There is **no CSI-2 RX block in RTL**, no ISP block, no `v4l2` driver, no
sensor selected, no `package/camera/` directory.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| CSI-2 RX controller | `rtl/camera/e1_csi2_rx.sv` + cocotb | Missing |
| D-PHY RX pad cells | `package/e1-demo-pinout.yaml` CSI entries | Not bonded |
| ISP pipeline | `rtl/camera/e1_isp.sv` or off-die ISP | Missing |
| Sensor selection | `package/camera/<sensor>.yaml` | Missing |
| V4L2 driver | `linux/drivers/media/platform/e1/` | Missing |
| libcamera IPA | `external/libcamera/src/ipa/e1/` | Missing |
| Camera HAL 3 | libcamera Android shim binding | Missing |
| Privacy indicator | Hardware LED + secure path | Missing |
| Calibration package | `package/camera/calibration/` | Missing |

## High-confidence recommendations

1. **Pick a sensor with a public driver path first.** OmniVision OV5640 or
   OV13B class is the only realistic open route for a v0 camera. Sony Lytia
   / Samsung ISOCELL require NDA driver work that is out of scope.
2. **Land CSI-2 RX RTL before ISP.** A CSI-2 RX feeding a RAW V4L2 capture
   node (no ISP) is sufficient for bring-up. ISP can be deferred to a soft
   userspace pipeline (libcamera + CPU) initially.
3. **Use Rockchip rkisp1 as the V4L2 contract reference.** Mirror its DT
   binding and `media_controller` topology when authoring an E1 V4L2 driver.
4. **Defer phone-class HDR/WDR/AF/auto-tuning.** These require tuning data
   that does not exist for an open-build E1.
