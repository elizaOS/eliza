SHELL := /bin/sh

PYTHON ?= python3
VENV := .venv
VENV_PYTHON := $(VENV)/bin/python
BENCH_PYTHON := $(if $(wildcard $(VENV_PYTHON)),$(VENV_PYTHON),$(PYTHON))
RTL_TOP := e1_chip_top
RTL_SRCS := rtl/top/e1_chip_top.sv rtl/clock/e1_reset_sync.sv rtl/debug/e1_dbg_mmio_bridge.sv rtl/top/e1_soc_top.sv rtl/bootrom/e1_bootrom.sv rtl/dma/e1_dma.sv rtl/npu/e1_npu.sv rtl/display/e1_display.sv rtl/peripherals/e1_peripherals.sv rtl/cpu/e1_cpu_subsystem_stub.sv rtl/interconnect/e1_axi_lite_interconnect.sv rtl/memory/e1_axi_lite_dram.sv rtl/interrupts/e1_interrupt_controller.sv rtl/interconnect/e1_linux_soc_contract.sv
BUILD := build

.PHONY: ci-release-evidence evidence-regression-test formal-fast formal-strict openlane-orchestration-test physical-gates-test pipeline-check-strict strict-release-gate-test
.PHONY: chipyard-external-generation-plan chipyard-generated-path-check chipyard-generated-path-repair chipyard-import-preflight chipyard-linux-payload-check chipyard-payload-path-check chipyard-generated-ap-boot chipyard-verilator-linux-smoke-test chipyard-verilator-preflight chipyard-verilator-stale-path-repair cpu-ap-capture-plan-shell cpu-ap-capture-wire cpu-ap-capture-wire-preflight cpu-ap-dts-audit linux-boot-artifacts-check cpu-ap-boot-readiness-check minimum-linux-target-check minimum-linux-target-strict mvp-npu-ml-evidence-check minimum-linux-npu-target-check minimum-linux-npu-target-strict hello-npu-linux-smoke-check

.PHONY: venv tools lint lint-fix typecheck analysis verify-all smoke ci-fast ci-local ci-strict ci-pd benchmarks-dry-run benchmarks benchmark-tools benchmark-modeled-artifacts benchmark-modeled-cpu-npu cpu-npu-modeled-benchmark-eval cpu-npu-burst-sustained-policy cpu-npu-burst-thermal-transient cpu-npu-aosp-governor-trace cpu-npu-14a-process-eval cpu-npu-competitive-envelope benchmark-sim-metrics benchmark-cpu-ap-sim-metrics benchmark-cpu-ap-sota-sim-metrics benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test soc-thermal-sweep soc-thermal-sweep-test soc-optimization soc-optimization-work-order soc-optimization-test cpu-npu-2028-readiness-scorecard cpu-npu-2028-readiness-scorecard-test cpu-npu-manual-review cpu-npu-manual-review-test power-thermal-evidence-check power-thermal-evidence-test process-14a-effects-check process-14a-effects-test e1-npu-nnapi-proof-check mvp-status mvp-status-strict mvp-status-json mvp-simulator mvp-simulator-check mvp-simulator-status-test aosp-simulator-completion-check android-sim-peripheral-evidence linux-handoff-check chipyard-generator-check chipyard-generated-check chipyard-generated-linux-contract-check chipyard-verilator-linux-smoke-check cpu-ap-scaffold-check cpu-ap-capture-plan cpu-ap-capture-preflight cpu-ap-capture-wire cpu-ap-capture-wire-preflight cpu-ap-evidence-check cpu-ap-evidence-test cpu-ap-completion-gate no-hardware-action-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check scale-feasibility-gate verification-maturity-matrix-check project-plan-check prototype-status-dashboard-check phone-soc-claim-check product-feature-gates-check product-check product-release-check product-evidence-commands product-resolved-manifest pinout-check fpga-check fpga-release-check wifi-interface-check padframe-check board-package-evidence-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check manufacturing-artifacts-check manufacturing-artifacts-release-check kicad-artifacts-check package-artifacts-check fpga-artifacts-check real-world-gates-check antenna-metadata-check antenna-metadata-release-check pd-preflight-check pd-contract-check pd-signoff-manifest-check bootrom-check rtl-check stub-audit cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal synth openlane openlane-smoke openroad qemu renode qemu-check qemu-check-strict qemu-os-check qemu-status-test renode-check renode-check-strict renode-status-test android-sim-boot-check android-sim-status-test aosp-linux-preflight aosp-linux-handoff aosp-linux-handoff-build-only platform-contract-check software-contract-check buildroot-check buildroot-scaffold-check buildroot-import-check linux-bsp-check linux-scaffold-check linux-import-check aosp-bsp-check aosp-scaffold-check aosp-import-check bsp-scaffold-check software-bsp-check software-bsp-scaffold-check software-bsp-external-preflight software-bsp-evidence-check software-bsp-test docs-check tool-versions record-tool-versions pipeline-check archive-check archive-release clean

venv:
	@$(PYTHON) -m venv $(VENV)
	@$(VENV_PYTHON) -m pip install --upgrade pip
	@$(VENV_PYTHON) -m pip install -r requirements.txt

tools:
	@scripts/check_tools.sh

lint:
	@$(PYTHON) scripts/run_lint.py

lint-fix:
	@$(PYTHON) scripts/run_lint.py --fix

typecheck:
	@$(PYTHON) scripts/run_typecheck.py

analysis:
	@$(PYTHON) scripts/run_analysis.py

verify-all: lint typecheck smoke analysis cocotb cocotb-npu cocotb-contract cocotb-cpu qemu-status-test renode-status-test
	@echo "verify-all complete"

smoke: lint typecheck docs-check project-plan-check record-tool-versions mvp-npu-ml-evidence-check prototype-status-dashboard-check npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check soc-thermal-sweep soc-optimization soc-optimization-work-order cpu-npu-modeled-benchmark-eval cpu-npu-burst-sustained-policy cpu-npu-burst-thermal-transient cpu-npu-aosp-governor-trace cpu-npu-14a-process-eval cpu-npu-competitive-envelope cpu-npu-2028-readiness-scorecard cpu-npu-manual-review scale-feasibility-gate verification-maturity-matrix-check platform-contract-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check power-thermal-evidence-check power-thermal-evidence-test process-14a-effects-check process-14a-effects-test chipyard-generator-check cpu-ap-scaffold-check cpu-ap-evidence-test cpu-ap-completion-gate stub-audit bsp-scaffold-check software-bsp-check qemu-check renode-check benchmarks-dry-run rtl-check synth
	@echo "smoke complete"

ci-fast: lint typecheck docs-check project-plan-check npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check scale-feasibility-gate verification-maturity-matrix-check platform-contract-check pinout-check stub-audit rtl-check synth cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal record-tool-versions mvp-npu-ml-evidence-check prototype-status-dashboard-check product-check
	@echo "ci-fast complete"

ci-local: lint typecheck docs-check platform-contract-check pinout-check product-check rtl-check synth cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal record-tool-versions mvp-npu-ml-evidence-check prototype-status-dashboard-check tool-versions
	@echo "ci-local complete"

ci-strict: REQUIRE_SBY=1
ci-strict: ci-local
	@$(PYTHON) scripts/pipeline_check.py
	@echo "ci-strict complete"

ci-release-evidence: REQUIRE_SBY=1
ci-release-evidence: REQUIRE_DEEP_FORMAL=1
ci-release-evidence: docs-check project-plan-check platform-contract-check pinout-check stub-audit rtl-check synth cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal-strict prototype-status-dashboard-check product-release-check tool-versions pipeline-check-strict
	@echo "ci-release-evidence complete"

ci-pd: openlane pd-signoff-check
	@echo "ci-pd complete"

benchmarks-dry-run: benchmark-modeled-artifacts
	@PATH="$(CURDIR)/$(VENV)/bin:$$PATH" $(BENCH_PYTHON) benchmarks/run_benchmarks.py --dry-run --report-id dry-run

benchmark-tools:
	@$(BENCH_PYTHON) benchmarks/install_host_benchmark_tools.py
	@$(BENCH_PYTHON) benchmarks/models/generate_mobile_smoke_tflite.py --out benchmarks/models/mobile_smoke.tflite --status-json benchmarks/results/tflite-generator-status.json

benchmark-modeled-artifacts: benchmark-cpu-ap-sim-metrics benchmark-cpu-ap-sota-sim-metrics benchmark-sim-metrics-test

benchmark-modeled-cpu-npu: benchmark-modeled-artifacts
	@$(BENCH_PYTHON) benchmarks/run_benchmarks.py run --bench npu_arch_sim_open_2028 --bench npu_arch_sim_sota_2028 --bench simulator_arch_metrics --bench cpu_arch_sim_sota_2028 --report-id modeled-cpu-npu-2028-local

cpu-npu-modeled-benchmark-eval: soc-optimization benchmark-modeled-cpu-npu
	@$(PYTHON) scripts/check_cpu_npu_modeled_benchmark_eval.py

cpu-npu-burst-sustained-policy: cpu-npu-modeled-benchmark-eval
	@$(PYTHON) scripts/check_cpu_npu_burst_sustained_policy.py

cpu-npu-burst-thermal-transient: cpu-npu-burst-sustained-policy
	@$(PYTHON) scripts/check_cpu_npu_burst_thermal_transient.py

cpu-npu-aosp-governor-trace: cpu-npu-burst-thermal-transient
	@$(PYTHON) scripts/check_cpu_npu_aosp_governor_trace.py

cpu-npu-14a-process-eval: cpu-npu-aosp-governor-trace process-14a-effects-check
	@$(PYTHON) scripts/check_cpu_npu_14a_process_eval.py

cpu-npu-competitive-envelope: cpu-npu-14a-process-eval
	@$(PYTHON) scripts/check_cpu_npu_competitive_envelope.py

benchmark-sim-metrics: qemu-check
	@$(PYTHON) benchmarks/generate_simulator_arch_metrics.py

benchmark-cpu-ap-sim-metrics:
	@$(PYTHON) benchmarks/generate_simulator_arch_metrics.py --mode model-14a-cpu-ap

benchmark-cpu-ap-sota-sim-metrics:
	@$(PYTHON) benchmarks/generate_simulator_arch_metrics.py --mode model-14a-cpu-ap --profile sota_2core --base-frequency-hz 3800000000 --base-power-w 3.1 --ipc-scale 1.35 --mpki-scale 0.62 --out benchmarks/results/simulator-arch-metrics-sota.json

benchmark-sim-metrics-test:
	@$(PYTHON) scripts/test_simulator_arch_metrics.py

benchmark-calibration-test:
	@$(PYTHON) scripts/test_benchmark_calibration.py

benchmark-parser-test:
	@$(PYTHON) scripts/test_benchmark_parsers.py

soc-thermal-sweep:
	@$(PYTHON) scripts/check_soc_thermal_sweep.py

soc-thermal-sweep-test:
	@$(PYTHON) scripts/test_soc_thermal_sweep.py

soc-optimization:
	@$(PYTHON) scripts/check_soc_optimization.py

soc-optimization-test:
	@$(PYTHON) scripts/test_soc_optimization.py

soc-optimization-work-order:
	@$(PYTHON) scripts/check_soc_optimized_work_order.py

cpu-npu-2028-readiness-scorecard: cpu-npu-competitive-envelope
	@$(PYTHON) scripts/check_cpu_npu_2028_readiness_scorecard.py

cpu-npu-2028-readiness-scorecard-test:
	@$(PYTHON) scripts/test_cpu_npu_2028_readiness_scorecard.py

cpu-npu-manual-review: cpu-npu-2028-readiness-scorecard
	@$(PYTHON) scripts/check_cpu_npu_manual_review.py

cpu-npu-manual-review-test:
	@$(PYTHON) scripts/test_cpu_npu_manual_review.py

power-thermal-evidence-check:
	@$(PYTHON) benchmarks/power/scripts/check_sustained_run_evidence.py benchmarks/power/manifests/e1-npu-sustained-capture.template.json --allow-blocked

power-thermal-evidence-test:
	@$(PYTHON) scripts/test_power_thermal_evidence.py

process-14a-effects-check:
	@$(PYTHON) scripts/check_process_14a_effects.py

process-14a-effects-test:
	@$(PYTHON) scripts/test_process_14a_effects.py

e1-npu-nnapi-proof-check:
	@$(PYTHON) scripts/check_e1_npu_nnapi_proof.py --probe-adb

benchmarks:
	@PATH="$(CURDIR)/$(VENV)/bin:$$PATH" $(BENCH_PYTHON) benchmarks/run_benchmarks.py

mvp-status:
	@$(PYTHON) scripts/check_mvp_status.py

mvp-status-strict:
	@$(PYTHON) scripts/check_mvp_status.py --strict

mvp-status-json:
	@mkdir -p build/reports
	@$(PYTHON) scripts/check_mvp_status.py --json | tee build/reports/mvp_status.json

mvp-simulator:
	@$(PYTHON) scripts/run_mvp_simulator.py

mvp-simulator-check:
	@$(PYTHON) scripts/check_mvp_simulator.py

mvp-simulator-status-test:
	@$(PYTHON) scripts/test_mvp_simulator_status.py

aosp-simulator-completion-check:
	@$(PYTHON) scripts/check_aosp_simulator_completion_gate.py

android-sim-peripheral-evidence:
	@$(PYTHON) scripts/android/capture_simulated_peripheral_evidence.py

linux-handoff-check:
	@scripts/linux_handoff_check.sh

linux-boot-artifacts-check:
	@$(PYTHON) scripts/check_linux_boot_artifacts.py

cpu-ap-boot-readiness-check:
	@$(PYTHON) scripts/check_cpu_ap_boot_readiness.py

minimum-linux-target-check:
	@$(PYTHON) scripts/check_minimum_linux_target.py

minimum-linux-target-strict:
	@$(PYTHON) scripts/check_minimum_linux_target.py --strict

mvp-npu-ml-evidence-check:
	@$(PYTHON) scripts/check_mvp_npu_ml_evidence.py --run

minimum-linux-npu-target-check:
	@$(PYTHON) scripts/check_minimum_linux_npu_target.py

minimum-linux-npu-target-strict:
	@$(PYTHON) scripts/check_minimum_linux_npu_target.py --strict

hello-npu-linux-smoke-check:
	@$(PYTHON) scripts/check_hello_npu_linux_smoke.py

chipyard-generator-check:
	@$(PYTHON) scripts/check_chipyard_generator_manifest.py

chipyard-import-preflight:
	@$(PYTHON) scripts/check_chipyard_import_preflight.py --require-checkout

chipyard-verilator-preflight:
	@$(PYTHON) scripts/check_chipyard_verilator_preflight.py

chipyard-generated-check:
	@$(PYTHON) scripts/check_chipyard_generator_manifest.py --require-generated

chipyard-generated-linux-contract-check:
	@$(PYTHON) scripts/check_chipyard_generated_linux_contract.py

chipyard-payload-path-check:
	@$(PYTHON) scripts/check_chipyard_payload_path.py

chipyard-linux-payload-check:
	@$(PYTHON) scripts/locate_chipyard_linux_payload.py --require

chipyard-generated-ap-boot:
	@scripts/run_chipyard_eliza_linux_smoke.sh

chipyard-generated-path-check:
	@$(PYTHON) scripts/repair_chipyard_generated_paths.py

chipyard-generated-path-repair:
	@$(PYTHON) scripts/repair_chipyard_generated_paths.py --rewrite

chipyard-external-generation-plan:
	@printf '%s\n' 'python3 scripts/check_chipyard_import_preflight.py --require-checkout'
	@printf '%s\n' 'python3 scripts/check_chipyard_verilator_preflight.py'
	@printf '%s\n' 'scripts/run_chipyard_eliza_verilator.sh'
	@printf '%s\n' 'python3 scripts/generate_chipyard_eliza.py'
	@printf '%s\n' 'python3 scripts/check_chipyard_generator_manifest.py --require-generated'
	@printf '%s\n' 'python3 scripts/capture_cpu_ap_evidence.py plan all --format shell'
	@printf '%s\n' 'scripts/capture_chipyard_linux_evidence.sh preflight'

chipyard-verilator-linux-smoke-check:
	@$(PYTHON) scripts/check_chipyard_verilator_linux_smoke.py

chipyard-verilator-linux-smoke-test:
	@$(PYTHON) scripts/test_chipyard_verilator_linux_smoke.py
	@$(PYTHON) scripts/test_chipyard_verilator_smoke_robustness.py

chipyard-verilator-stale-path-repair:
	@$(PYTHON) scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated

cpu-ap-scaffold-check:
	@$(PYTHON) scripts/check_cpu_ap_evidence.py

cpu-ap-capture-plan:
	@$(PYTHON) scripts/capture_cpu_ap_evidence.py plan all --format text

cpu-ap-capture-plan-shell:
	@$(PYTHON) scripts/capture_cpu_ap_evidence.py plan all --format shell

cpu-ap-capture-wire:
	@$(PYTHON) scripts/wire_cpu_ap_capture_commands.py --format shell

cpu-ap-capture-wire-preflight:
	@scripts/capture_chipyard_linux_evidence.sh wire-preflight

cpu-ap-capture-preflight:
	@scripts/capture_chipyard_linux_evidence.sh preflight

cpu-ap-dts-audit:
	@$(PYTHON) scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc

cpu-ap-evidence-check:
	@$(PYTHON) scripts/check_cpu_ap_evidence.py --require-evidence

cpu-ap-evidence-test:
	@$(PYTHON) scripts/test_cpu_ap_evidence.py

cpu-ap-completion-gate:
	@$(PYTHON) scripts/check_cpu_ap_completion_gate.py

no-hardware-action-check:
	@$(PYTHON) scripts/check_no_hardware_action_matrix.py

memory-uma-claim-gate:
	@$(PYTHON) scripts/check_memory_uma_claim_gate.py

memory-evidence-template-check:
	@$(PYTHON) scripts/check_memory_evidence_templates.py

memory-interconnect-contract-check:
	@$(PYTHON) scripts/check_memory_interconnect_contract.py

npu-2028-target-check:
	@$(PYTHON) scripts/check_npu_2028_targets.py

npu-runtime-contract-check:
	@$(PYTHON) scripts/check_e1_npu_runtime_contract.py

npu-roadmap-check:
	@$(PYTHON) scripts/check_npu_roadmap.py

npu-open-scale-model-check:
	@$(PYTHON) scripts/check_npu_open_scale_model.py

npu-scale-sim-check:
	@$(PYTHON) scripts/check_npu_scale_sim.py

scale-feasibility-gate:
	@$(PYTHON) scripts/check_scale_feasibility_gate.py

verification-maturity-matrix-check:
	@$(PYTHON) scripts/check_verification_maturity_matrix.py

product-check: pinout-check fpga-check wifi-interface-check padframe-check board-package-evidence-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check pd-signoff-manifest-check manufacturing-artifacts-check real-world-gates-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check product-feature-gates-check
	@$(PYTHON) scripts/product_check.py

product-release-check: pinout-check fpga-check wifi-interface-check padframe-check board-package-evidence-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check pd-signoff-manifest-check manufacturing-artifacts-check real-world-gates-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check product-feature-gates-check
	@$(PYTHON) scripts/product_check.py --release

product-evidence-commands:
	@$(PYTHON) scripts/run_product_evidence_command.py --list

product-resolved-manifest:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --resolved-manifest build/reports/manufacturing-resolved-artifacts.json

project-plan-check:
	@$(PYTHON) scripts/check_project_plan.py

prototype-status-dashboard-check:
	@$(PYTHON) scripts/check_prototype_status_dashboard.py

phone-soc-claim-check:
	@$(PYTHON) scripts/check_phone_soc_claims.py

product-feature-gates-check:
	@$(PYTHON) scripts/check_product_feature_gates.py

pinout-check:
	@$(PYTHON) package/scripts/validate_pinout.py package/e1-demo-pinout.yaml

fpga-check:
	@$(PYTHON) scripts/check_fpga_target.py

fpga-release-check:
	@$(PYTHON) scripts/check_fpga_release.py --release

wifi-interface-check:
	@$(PYTHON) scripts/check_wifi_interface.py

padframe-check:
	@$(PYTHON) scripts/check_padframe_contract.py

board-package-evidence-check:
	@$(PYTHON) scripts/check_board_package_evidence.py

package-cross-probe-check:
	@$(PYTHON) scripts/check_package_cross_probe.py

kicad-artifact-check:
	@$(PYTHON) scripts/check_kicad_artifacts.py

openlane-run-preflight-check:
	@$(PYTHON) scripts/check_openlane_run_preflight.py

physical-closure-work-order-check:
	@$(PYTHON) scripts/check_physical_closure_work_order.py

manufacturing-artifacts-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py

manufacturing-artifacts-release-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --release

kicad-artifacts-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --manifest board/kicad/e1-demo/artifact-manifest.yaml

package-artifacts-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --manifest package/artifact-manifest.yaml

fpga-artifacts-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --manifest board/fpga/artifact-manifest.yaml

physical-gates-test:
	@$(PYTHON) scripts/test_physical_gates.py

real-world-gates-check:
	@$(PYTHON) scripts/check_real_world_gates.py

antenna-metadata-check:
	@$(PYTHON) scripts/check_antenna_metadata.py

antenna-metadata-release-check:
	@$(PYTHON) scripts/check_antenna_metadata.py --release

pd-preflight-check:
	@$(PYTHON) scripts/check_pd_preflight.py

pd-contract-check: padframe-check physical-closure-work-order-check pd-preflight-check antenna-metadata-check pd-signoff-manifest-check manufacturing-artifacts-check real-world-gates-check
	@echo "pd contract checks complete"

pd-signoff-manifest-check:
	@$(PYTHON) scripts/check_pd_signoff.py --manifest-only

pd-signoff-check:
	@$(PYTHON) scripts/check_pd_signoff.py

openlane-orchestration-test:
	@$(PYTHON) scripts/test_openlane_orchestration.py

bootrom-check:
	@$(PYTHON) fw/boot-rom/check_boot_rom.py

rtl-check:
	@scripts/run_rtl_check.sh

stub-audit:
	@$(PYTHON) verify/check_stub_audit.py

cocotb:
	@PYTHON=$(VENV_PYTHON) scripts/run_cocotb.sh

cocotb-npu:
	@PYTHON=$(VENV_PYTHON) COCOTB_MODULE=test_e1_npu COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh

cocotb-contract:
	@PYTHON=$(VENV_PYTHON) COCOTB_MODULE=test_cpu_mem_intc_contract COCOTB_TOPLEVEL=e1_linux_soc_contract scripts/run_cocotb.sh

cocotb-cpu:
	@PYTHON=$(VENV_PYTHON) COCOTB_MODULE=test_tiny_cpu_execution COCOTB_TOPLEVEL=e1_tiny_cpu_contract_tb scripts/run_cocotb.sh

verilator:
	@scripts/run_verilator.sh

formal:
	@scripts/run_formal.sh

formal-fast:
	@scripts/run_formal.sh

formal-strict:
	@REQUIRE_SBY=1 REQUIRE_DEEP_FORMAL=1 scripts/run_formal.sh

synth:
	@scripts/run_yosys.sh

openlane:
	@scripts/run_openlane.sh

openlane-smoke:
	@OPENLANE_CONFIG=pd/openlane/config.pd-smoke.sky130.json scripts/run_openlane.sh

openroad:
	@scripts/run_openroad.sh

qemu:
	@scripts/run_qemu.sh

renode:
	@scripts/run_renode.sh

qemu-check: platform-contract-check
	@scripts/run_qemu.sh --check

qemu-check-strict: platform-contract-check
	@REQUIRE_QEMU=1 scripts/run_qemu.sh --check

qemu-os-check: platform-contract-check
	@scripts/run_qemu.sh --check-os

qemu-status-test:
	@$(PYTHON) scripts/test_qemu_smoke_status.py

renode-check: platform-contract-check
	@scripts/run_renode.sh --check

renode-check-strict: platform-contract-check
	@REQUIRE_RENODE=1 scripts/run_renode.sh --check

renode-status-test:
	@$(PYTHON) scripts/test_renode_status.py

android-sim-boot-check:
	@scripts/boot_android_simulator.sh --run-cuttlefish --run-cts --run-vts

android-sim-status-test:
	@$(PYTHON) scripts/test_android_sim_boot_status.py
	@$(PYTHON) scripts/test_aosp_evidence_strictness.py
	@$(PYTHON) scripts/test_android_peripheral_evidence.py

aosp-linux-preflight:
	@$(PYTHON) scripts/check_aosp_linux_preflight.py --write-report

aosp-linux-handoff:
	@scripts/run_aosp_linux_handoff.sh

aosp-linux-handoff-build-only:
	@scripts/run_aosp_linux_handoff.sh --build-only

platform-contract-check:
	@$(PYTHON) scripts/check_platform_contract.py

platform-artifacts:
	@$(PYTHON) scripts/gen_platform_artifacts.py

platform-artifacts-check:
	@$(PYTHON) scripts/gen_platform_artifacts.py --check

software-contract-check: platform-contract-check

buildroot-check:
	@$(PYTHON) scripts/check_software_bsp.py buildroot

buildroot-scaffold-check:
	@$(PYTHON) scripts/check_software_bsp.py buildroot --scaffold-only

buildroot-import-check:
	@if [ -z "$${BUILDROOT_TREE:-}" ]; then \
		echo "STATUS: BLOCKED buildroot.import-check - set BUILDROOT_TREE=/path/to/buildroot"; \
		exit 0; \
	fi; \
	sw/buildroot/scripts/import-buildroot-external.sh --check "$$BUILDROOT_TREE"

linux-bsp-check:
	@$(PYTHON) scripts/check_software_bsp.py linux

linux-scaffold-check:
	@$(PYTHON) scripts/check_software_bsp.py linux --scaffold-only

linux-import-check:
	@if [ -z "$${LINUX_TREE:-}" ]; then \
		echo "STATUS: BLOCKED linux.import-check - set LINUX_TREE=/path/to/linux"; \
		exit 0; \
	fi; \
	sw/linux/scripts/import-linux-bsp.sh --check "$$LINUX_TREE"

aosp-bsp-check:
	@$(PYTHON) scripts/check_software_bsp.py aosp

aosp-scaffold-check:
	@$(PYTHON) scripts/check_software_bsp.py aosp --scaffold-only

aosp-import-check:
	@if [ -z "$${AOSP_TREE:-}" ]; then \
		echo "STATUS: BLOCKED aosp.import-check - set AOSP_TREE=/path/to/aosp"; \
		exit 0; \
	fi; \
	sw/aosp-device/import-aosp-device.sh --check "$$AOSP_TREE"

bsp-scaffold-check:
	@$(PYTHON) sw/check_bsp_scaffolds.py all

software-bsp-check:
	@$(PYTHON) scripts/check_software_bsp.py all

software-bsp-scaffold-check:
	@$(PYTHON) scripts/check_software_bsp.py all --scaffold-only

software-bsp-external-preflight:
	@$(PYTHON) scripts/check_software_bsp.py external-preflight all --write-report

software-bsp-evidence-check:
	@$(PYTHON) scripts/check_software_bsp.py all --require-evidence

software-bsp-test:
	@$(PYTHON) scripts/test_software_bsp_checks.py
	@$(PYTHON) scripts/test_software_bsp_evidence.py

evidence-regression-test: no-hardware-action-check software-bsp-test physical-gates-test product-feature-gates-check benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test renode-status-test cocotb cocotb-npu cocotb-contract cocotb-cpu record-tool-versions strict-release-gate-test
	@echo "evidence regression tests complete"

docs-check:
	@$(PYTHON) scripts/docs_check.py

tool-versions:
	@scripts/tool_versions.sh

record-tool-versions:
	@mkdir -p build/reports
	@scripts/tool_versions.sh > build/reports/tool_versions.txt

pipeline-check:
	@$(PYTHON) scripts/pipeline_check.py

pipeline-check-strict:
	@$(PYTHON) scripts/pipeline_check.py --strict-formal

strict-release-gate-test:
	@$(PYTHON) scripts/test_strict_release_gates.py

archive-release: pipeline-check
	@scripts/archive_release.sh

archive-check:
	@$(PYTHON) scripts/check_release_archive.py $(ARCHIVE)

clean:
	rm -rf $(BUILD) sim_build sim_build_* results reports verify/formal/work verify/cocotb/sim_build verify/cocotb/sim_build_* verify/cocotb/results.xml verify/formal/e1_dbg_mmio_bridge verify/formal/e1_npu verify/formal/e1_dma verify/formal/e1_soc_top

# ---------------------------------------------------------------------------
# Boot pipeline tiers (QEMU virt)
#   tier0        bare-metal E1
#   tier1        OpenSBI + S-mode payload (BLOCKED on macOS)
#   tier2-build  build kernel Image + busybox initramfs via docker
#   tier2-boot   boot Linux + initramfs under qemu-system-riscv64
#   tier2        tier2-build && tier2-boot
# ---------------------------------------------------------------------------
.PHONY: tier0 tier1 tier2 tier2-build tier2-boot boot-pipeline-status

TIER0_ELF    := fw/bare-metal/e1/e1.elf
TIER1_FW     := external/opensbi/build/platform/generic/firmware/fw_payload.elf
TIER2_KERNEL := build/sim/tier2/Image
TIER2_INITRD := build/initramfs/eliza_tier2.cpio.gz

tier0:
	@$(MAKE) -C fw/bare-metal/e1
	@scripts/sim/run_qemu_baremetal.sh

tier1:
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		echo "[tier1] BLOCKED on macOS: OpenSBI fw_payload link requires GNU binutils -pie."; \
		echo "[tier1] See docs/sim/tier1-opensbi-macos-blocker.md"; \
		exit 2; \
	fi
	@scripts/build/build_opensbi_qemu.sh
	@scripts/sim/run_qemu_opensbi.sh

tier2-build:
	@if ! command -v docker >/dev/null 2>&1; then \
		echo "[tier2-build] ERROR: docker not on PATH"; exit 2; \
	fi
	@if ! docker info >/dev/null 2>&1; then \
		echo "[tier2-build] ERROR: docker daemon not running"; exit 2; \
	fi
	@scripts/build/docker_build_tier2.sh

tier2-boot:
	@if [ ! -f "$(TIER2_KERNEL)" ] || [ ! -f "$(TIER2_INITRD)" ]; then \
		echo "[tier2-boot] MISSING: $(TIER2_KERNEL) and/or $(TIER2_INITRD) -- run 'make tier2-build' first"; \
		exit 2; \
	fi
	@KERNEL=$(TIER2_KERNEL) INITRD=$(TIER2_INITRD) $(PYTHON) scripts/sim/run_qemu_tier2_check.py

tier2: tier2-build tier2-boot

boot-pipeline-status:
	@if [ -f "$(TIER0_ELF)" ]; then \
		echo "tier0:       READY    artifact=$(TIER0_ELF)"; \
	else \
		echo "tier0:       MISSING  artifact=$(TIER0_ELF) (run 'make tier0')"; \
	fi
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		echo "tier1:       BLOCKED  macOS binutils -pie (see docs/sim/tier1-opensbi-macos-blocker.md)"; \
	elif [ -f "$(TIER1_FW)" ]; then \
		echo "tier1:       READY    artifact=$(TIER1_FW)"; \
	else \
		echo "tier1:       MISSING  artifact=$(TIER1_FW) (run 'make tier1')"; \
	fi
	@if [ -f "$(TIER2_KERNEL)" ] && [ -f "$(TIER2_INITRD)" ]; then \
		echo "tier2:       READY    kernel+initrd present under build/sim/tier2"; \
	else \
		echo "tier2:       MISSING  kernel=$(TIER2_KERNEL) initrd=$(TIER2_INITRD) (run 'make tier2-build')"; \
	fi
