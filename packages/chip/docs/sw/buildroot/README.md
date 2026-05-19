# Buildroot target

Buildroot is the first full Linux userspace target before Android. It must consume `sw/platform/e1_platform_contract.json` or generated headers from it for e1 MMIO base addresses and register offsets.

`make buildroot-check` rejects a documentation-only target. The check expects the first real target to provide:

```text
sw/buildroot/external.desc
sw/buildroot/Config.in
sw/buildroot/external.mk
sw/buildroot/scripts/import-buildroot-external.sh
sw/buildroot/configs/eliza_e1_defconfig
sw/buildroot/board/eliza/e1/linux.fragment
sw/buildroot/board/eliza/e1/rootfs_overlay/usr/bin/e1-mmio-smoke
sw/buildroot/package/e1-mmio-smoke/Config.in
sw/buildroot/package/e1-mmio-smoke/e1-mmio-smoke.mk
sw/buildroot/package/e1-mmio-smoke/src/e1-mmio-smoke.c
sw/buildroot/package/e1-npu-ml-smoke/Config.in
sw/buildroot/package/e1-npu-ml-smoke/e1-npu-ml-smoke.mk
sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c
serial console
initramfs
e1 NPU userspace test
framebuffer smoke test
DMA smoke test
```

The Linux fragment also enables the kernel symbols needed for the external
SDIO `brcmfmac` WiFi and UART `hci_uart_bcm` Bluetooth reference slice. Those
symbols are BSP preparation only; the checked-in DTS keeps the module disabled
until board RTL and pin constraints provide the required host interfaces.

## Repo-local scaffold check

Command:

```sh
make buildroot-check
python3 sw/check_bsp_scaffolds.py buildroot
```

Expected output:

```text
buildroot: scaffold audit
  local command: make buildroot-check
  expected output: buildroot BSP check passed.
  dependency blocker: external Buildroot checkout and external Linux kernel tarball/tree
  status: clear
buildroot BSP check failed:
  - buildroot BSP BLOCKED: missing evidence for external Buildroot image build plus e1 MMIO and e1 NPU ML smoke transcripts: docs/evidence/buildroot/eliza_e1_defconfig.log, docs/evidence/buildroot/eliza_e1_image_manifest.txt, docs/evidence/buildroot/e1-mmio-smoke.log, docs/evidence/buildroot/e1-npu-ml-smoke.log
```

Dependency blocker: a real Buildroot image requires an external Buildroot
checkout and a kernel source/tarball that already contains the imported
Eliza Linux BSP. The checked-in `BR2_EXTERNAL` tree does not download
Buildroot or provide `../linux-external.tar.xz`.

Evidence intake is defined by
`docs/evidence/software-bsp-evidence-manifest.json` and validated by
`make software-bsp-evidence-check`. A file existing under `docs/evidence` is
not enough: the transcript must include the `eliza-evidence` header/footer,
the exact command marker, and the target-specific pass markers. Templates,
substitute-only logs, failed transcripts, and too-small files are rejected.

Environment readiness can be checked without creating evidence logs:

```sh
python3 scripts/check_software_bsp.py external-preflight buildroot \
  --buildroot /path/to/buildroot \
  --target-host root@TARGET \
  --write-report
```

## External Buildroot import

Use this directory as a `BR2_EXTERNAL` tree from an existing Buildroot checkout:

```sh
sw/buildroot/scripts/import-buildroot-external.sh /path/to/buildroot
cd /path/to/buildroot
make BR2_EXTERNAL=/path/to/Eliza-AI-SoC/sw/buildroot eliza_e1_defconfig
make BR2_EXTERNAL=/path/to/Eliza-AI-SoC/sw/buildroot
```

The helper only validates paths and prints deterministic commands. It does not
download Buildroot, fetch a kernel tarball, or start a full build.

Expected helper output starts with:

```text
Run from the Buildroot checkout:
  make BR2_EXTERNAL=/path/to/Eliza-AI-SoC/sw/buildroot eliza_e1_defconfig
```

## External evidence capture

From this repository, with `/path/to/buildroot` already provisioned:

```sh
sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot defconfig
sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot image-manifest
E1_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-mmio-smoke' \
  sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot smoke
E1_NPU_ML_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu' \
  sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot ml-smoke
make software-bsp-evidence-check
```

The `image-manifest` mode records SHA-256 hashes for files already present in
`output/images`; it fails if no image build exists. The `smoke` mode fails
unless `E1_SMOKE_CMD` exits zero on the external target. The `ml-smoke` mode
is separate and fails unless `E1_NPU_ML_SMOKE_CMD` exits zero and the target
transcript includes `e1-npu-ml-smoke: PASS`,
`workload=gemm_s8_int8_2x2x3`, `--require-npu`, `/dev/e1-npu`, and
`claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark`.
