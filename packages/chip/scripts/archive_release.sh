#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_dir="$repo_dir/build/release/eliza_e1_demo_$stamp"

mkdir -p "$archive_dir"

if [ -d "$repo_dir/build/reports" ]; then
    cp -R "$repo_dir/build/reports" "$archive_dir/reports"
fi
if [ -d "$repo_dir/build/renode" ]; then
    cp -R "$repo_dir/build/renode" "$archive_dir/renode"
fi
if [ -d "$repo_dir/build/netlist" ]; then
    cp -R "$repo_dir/build/netlist" "$archive_dir/netlist"
fi
if [ -d "$repo_dir/pd/openlane/runs" ]; then
    mkdir -p "$archive_dir/pd/openlane"
    cp -R "$repo_dir/pd/openlane/runs" "$archive_dir/pd/openlane/runs"
fi

while IFS= read -r path; do
    [ -z "$path" ] && continue
    [ -f "$repo_dir/$path" ] || continue
    mkdir -p "$archive_dir/source/$(dirname "$path")"
    cp "$repo_dir/$path" "$archive_dir/source/$path"
done <<'EOF'
docs/README.md
Makefile
Dockerfile
.github/workflows/ci.yml
docs/arch/debug.md
docs/arch/memory-map.md
rtl/top/e1_chip_top.sv
rtl/debug/e1_dbg_mmio_bridge.sv
rtl/clock/e1_reset_sync.sv
rtl/top/e1_soc_top.sv
rtl/bootrom/e1_bootrom.sv
rtl/peripherals/e1_peripherals.sv
rtl/dma/e1_dma.sv
rtl/npu/e1_npu.sv
rtl/display/e1_display.sv
verify/cocotb/test_e1_chip.py
package/e1-demo-pinout.yaml
docs/package/e1-demo-package.md
docs/package/e1-demo-pad-ring.md
pd/pin_order.cfg
pd/constraints/e1_soc.sdc
pd/constraints/e1_soc_gf180.sdc
docs/manufacturing/release-manifest.yaml
docs/manufacturing/e1-demo-checklist.md
docs/manufacturing/real-world-verification-gaps.yaml
docs/manufacturing/physical-closure-work-order.yaml
docs/toolchain/README.md
docs/toolchain/headless-cli-audit.md
docs/spec-db/mobile-sota-2026.yaml
docs/benchmarks/benchmark-matrix.md
docs/benchmarks/harness.md
docs/benchmarks/report-schema.yaml
docs/android/riscv-bringup.md
docs/project/three-week-execution-plan.md
docs/project/workstreams.md
docs/risks/risk-register.md
docs/rtl/open_rtl_prototype_path.md
benchmarks/configs/benchmark_plan.json
benchmarks/configs/fio-rand-rw.fio
benchmarks/configs/fio-seq-read.fio
docs/benchmarks/models/README.md
benchmarks/run_benchmarks.py
docs/board/README.md
benchmarks/install_host_benchmark_tools.py
benchmarks/metadata/local-host-smoke.json
benchmarks/models/mobile_smoke.tflite
benchmarks/tools/coremark
benchmarks/tools/stream_c.exe
benchmarks/tools/bw_mem
benchmarks/tools/lat_mem_rd
benchmarks/tools/benchmark_model
docs/benchmarks/models/README.md
benchmarks/run_benchmarks.py
board/README.md
docs/board/fpga/README.md
board/fpga/e1_demo_fpga.yaml
board/fpga/constraints/e1_demo_ulx3s.lpf
docs/board/kicad/e1-demo/fab-notes.md
docs/fw/board-smoke/tests/smoke_plan.md
scripts/check_cocotb_results.py
scripts/check_mvp_status.py
scripts/check_project_plan.py
scripts/check_real_world_gates.py
scripts/check_physical_closure_work_order.py
scripts/check_software_bsp.py
scripts/pipeline_check.py
scripts/run_cocotb.sh
scripts/run_formal.sh
scripts/run_qemu.sh
scripts/run_renode.sh
scripts/tool_versions.sh
scripts/yosys_formal_npu_structural.ys
scripts/yosys_formal_top_structural.ys
sw/platform/e1_platform_contract.json
sw/platform/generated/e1_platform_contract.h
sw/bootrom/e1_qemu_firmware.S
sw/bootrom/linker.ld
docs/sw/aosp-device/README.md
sw/aosp-device/import-aosp-device.sh
sw/aosp-device/manifests/eliza-ai-soc-local.xml
sw/aosp-device/device/eliza/eliza_ai_soc/AndroidProducts.mk
sw/aosp-device/device/eliza/eliza_ai_soc/eliza_ai_soc.mk
sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk
sw/aosp-device/device/eliza/eliza_ai_soc/device.mk
sw/aosp-device/device/eliza/eliza_ai_soc/init.eliza.rc
sw/aosp-device/device/eliza/eliza_ai_soc/fstab.eliza
sw/aosp-device/device/eliza/eliza_ai_soc/manifest.xml
sw/aosp-device/device/eliza/eliza_ai_soc/kernel/eliza_ai_soc.fragment
sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts
sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/file_contexts
sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/e1_npu.te
docs/sw/buildroot/README.md
sw/buildroot/external.desc
sw/buildroot/Config.in
sw/buildroot/external.mk
sw/buildroot/configs/eliza_e1_defconfig
sw/buildroot/scripts/import-buildroot-external.sh
sw/buildroot/board/eliza/e1/linux.fragment
sw/buildroot/board/eliza/e1/rootfs_overlay/usr/bin/e1-mmio-smoke
sw/check_bsp_scaffolds.py
docs/sw/linux/README.md
sw/linux/dts/eliza-e1.dts
sw/linux/drivers/e1/Kconfig
sw/linux/drivers/e1/Makefile
sw/linux/drivers/e1/e1-npu.c
sw/linux/drivers/e1/e1-dma.c
sw/linux/scripts/import-linux-bsp.sh
sw/linux/tests/e1-mmio-smoke.c
docs/sw/opensbi/README.md
docs/sw/u-boot/README.md
verify/check_stub_audit.py
verify/cocotb/e1_tiny_cpu_contract_tb.sv
verify/cocotb/test_cpu_mem_intc_contract.py
verify/cocotb/test_e1_display.py
verify/cocotb/test_e1_npu.py
verify/cocotb/test_e1_soc.py
verify/cocotb/test_tiny_cpu_execution.py
verify/verilator/test_npu_gemm.cpp
EOF

find "$archive_dir" -type f -print0 | sort -z | xargs -0 shasum -a 256 > "$archive_dir/SHA256SUMS"
tar -C "$repo_dir/build/release" -czf "$archive_dir.tar.gz" "$(basename "$archive_dir")"

echo "Release archive: $archive_dir.tar.gz"
