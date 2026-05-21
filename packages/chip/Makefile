SHELL := /bin/sh

PYTHON ?= python3
AI_EDA_RUN_ID ?= validation
AI_EDA_SETUP_RUN_ID ?= $(AI_EDA_RUN_ID)
AI_EDA_TRAINING_HANDOFF_RUN_ID ?= $(AI_EDA_RUN_ID)-training-handoff
VENV := .venv
VENV_PYTHON := $(VENV)/bin/python
BENCH_PYTHON := $(if $(wildcard $(VENV_PYTHON)),$(VENV_PYTHON),$(PYTHON))
COCOTB_PYTHON ?= $(shell if [ -x "$(VENV_PYTHON)" ] && "$(VENV_PYTHON)" -c "import cocotb" >/dev/null 2>&1; then printf '%s' "$(VENV_PYTHON)"; else command -v "$(PYTHON)" || printf '%s' "$(PYTHON)"; fi)
RTL_TOP := e1_chip_top
RTL_SRCS := rtl/top/e1_chip_top.sv rtl/clock/e1_reset_sync.sv rtl/debug/e1_dbg_mmio_bridge.sv rtl/top/e1_soc_top.sv rtl/bootrom/e1_bootrom.sv rtl/dma/e1_dma.sv rtl/npu/e1_npu.sv rtl/display/e1_display.sv rtl/peripherals/e1_peripherals.sv rtl/cpu/e1_cpu_subsystem_stub.sv rtl/interconnect/e1_axi_lite_interconnect.sv rtl/memory/e1_axi_lite_dram.sv rtl/memory/e1_weight_buffer_sram.sv rtl/interrupts/e1_interrupt_controller.sv rtl/interconnect/e1_linux_soc_contract.sv
BUILD := build

.PHONY: ci-release-evidence evidence-regression-test formal-fast formal-strict openlane-orchestration-test physical-gates-test pipeline-check-strict strict-release-gate-test
.PHONY: rail-plan-check upf-check pdn-workload-signoff pmic-procurement-gate cocotb-droop cocotb-clock-stretcher cocotb-avfs cocotb-pmc cocotb-power fw-pmc-build
.PHONY: chipyard-external-generation-plan chipyard-generated-path-check chipyard-generated-path-repair chipyard-import-preflight chipyard-linux-payload-check chipyard-payload-path-check chipyard-generated-ap-boot chipyard-verilator-linux-smoke-test chipyard-verilator-preflight chipyard-verilator-stale-path-repair cpu-ap-capture-plan-shell cpu-ap-capture-wire cpu-ap-capture-wire-preflight cpu-ap-dts-audit linux-boot-artifacts-check cpu-ap-boot-readiness-check minimum-linux-target-check minimum-linux-target-strict mvp-npu-ml-evidence-check minimum-linux-npu-target-check minimum-linux-npu-target-strict hello-npu-linux-smoke-check
.PHONY: tapeout-readiness tapeout-readiness-strict tapeout-readiness-test manufacturing-tapeout-scope-check manufacturing-tapeout-scope-test chip-os-bring-up-status
.PHONY: sota-parity-audit sota-parity-audit-strict sota-parity-audit-test
.PHONY: software-bsp-external-preflight software-bsp-evidence-check
.PHONY: e1-phone-display-fit
.PHONY: e1-phone-interface-closure
.PHONY: e1-phone-power-thermal
.PHONY: e1-phone-rf-connectivity
.PHONY: e1-phone-module-rf-pinout-execution
.PHONY: e1-phone-routed-pcb-implementation-execution
.PHONY: e1-phone-layout-optimization-execution
.PHONY: e1-phone-pinout-footprint-freeze
.PHONY: e1-phone-audio-acoustic
.PHONY: e1-phone-routed-release-plan
.PHONY: e1-phone-manufacturing-artifacts-check
.PHONY: cdc-rdc-intent-check
.PHONY: waveform-debug-policy-check
.PHONY: external-model-corpus-intake-policy-check
.PHONY: analog-automation-policy-check
.PHONY: hardware-security-ai-policy-check
.PHONY: dft-atpg-policy-check
.PHONY: power-thermal-ai-policy-check
.PHONY: software-bsp-firmware-ai-policy-check
.PHONY: spec-traceability-ai-policy-check

.PHONY: setup venv tools kicad-setup kicad-tools-check e1-phone-schematic-scaffold e1-phone-layout-metrics e1-phone-manufacturing-closure e1-phone-board-package-check kicad-phone-render kicad-phone-preview-check phone-cad phone-cad-test lint lint-fix typecheck analysis verify-all smoke ci-fast ci-local ci-strict ci-pd benchmarks-dry-run benchmarks benchmark-tools benchmarks-local-host-evidence benchmark-modeled-artifacts benchmark-modeled-cpu-npu cpu-npu-modeled-benchmark-eval cpu-npu-burst-sustained-policy cpu-npu-burst-thermal-transient cpu-npu-aosp-governor-trace cpu-npu-14a-process-eval cpu-npu-competitive-envelope cpu-npu-tapeout-readiness-audit cpu-npu-tapeout-readiness-audit-test cpu-npu-design-space-frontier benchmark-sim-metrics benchmark-cpu-ap-sim-metrics benchmark-cpu-ap-sota-sim-metrics benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test benchmark-efficiency-scope-check benchmark-efficiency-scope-test soc-thermal-sweep soc-thermal-sweep-test soc-optimization soc-optimization-work-order soc-optimization-test cpu-npu-2028-readiness-scorecard cpu-npu-2028-readiness-scorecard-test cpu-npu-manual-review cpu-npu-manual-review-test power-thermal-scope-check power-thermal-scope-test power-thermal-evidence-check power-thermal-evidence-test process-14a-effects-check process-14a-effects-test npu-scope-check npu-scope-test e1-npu-nnapi-proof-check mvp-status mvp-status-strict mvp-status-json mvp-simulator mvp-simulator-check mvp-simulator-status-test aosp-simulator-completion-check android-sim-peripheral-evidence linux-handoff-check chipyard-generator-check chipyard-generated-check chipyard-generated-linux-contract-check chipyard-verilator-linux-smoke-check cpu-ap-scaffold-check cpu-ap-scope-check cpu-ap-scope-test cpu-ap-capture-plan cpu-ap-capture-preflight cpu-ap-capture-wire cpu-ap-capture-wire-preflight cpu-ap-evidence-check cpu-ap-evidence-test cpu-ap-completion-gate no-hardware-action-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check memory-iommu-qos-sim-check memory-iommu-qos-sim-test memory-axi4-check iommu-evidence-check cocotb-axi4 cocotb-axi4-irq-w1c cocotb-axi4-multimaster cocotb-axi4-width-converter cocotb-dram-ctrl cocotb-iommu stream-bench lmbench-bw mlc-bench dma-buf-negative dramsim-sweep npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check npu-context-queue-sim-check npu-context-queue-sim-test scale-feasibility-gate verification-maturity-matrix-check project-plan-check prototype-status-dashboard-check phone-soc-claim-check phone-media-pipeline-scope-check phone-media-pipeline-scope-test security-lifecycle-scope-check security-lifecycle-scope-test radio-sensor-pmic-scope-check radio-sensor-pmic-scope-test product-feature-gates-check product-check product-check-status-test product-release-check product-evidence-commands product-resolved-manifest pinout-check fpga-check fpga-release-check wifi-interface-check padframe-check board-package-evidence-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check manufacturing-artifacts-check manufacturing-artifacts-release-check kicad-artifacts-check package-artifacts-check fpga-artifacts-check real-world-gates-check antenna-metadata-check antenna-metadata-release-check pd-preflight-check pd-contract-check pd-signoff-manifest-check bootrom-check rtl-check stub-audit cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal synth openlane openlane-smoke openroad qemu renode qemu-check qemu-check-strict qemu-os-check qemu-status-test renode-check renode-check-strict renode-status-test android-sim-boot-check android-sim-status-test aosp-linux-preflight aosp-linux-handoff aosp-linux-handoff-build-only platform-contract-check software-contract-check buildroot-check buildroot-scaffold-check buildroot-import-check buildroot-qemu-virt-smoke buildroot-qemu-virt-smoke-test aosp-build-preflight aosp-build-riscv64 bsp-scaffold-check software-bsp-check software-bsp-scaffold-check software-bsp-scope-check software-bsp-test docs-check tool-versions record-tool-versions pipeline-check archive-check archive-release clean

setup: kicad-setup venv tools kicad-tools-check
	@echo "packages/chip setup complete"

venv:
	@if [ ! -x "$(VENV_PYTHON)" ]; then \
		$(PYTHON) -m venv $(VENV) || { rm -rf $(VENV); $(PYTHON) -m virtualenv $(VENV); }; \
	fi
	@$(VENV_PYTHON) -m pip install --upgrade pip
	@$(VENV_PYTHON) -m pip install -r requirements.txt

tools:
	@scripts/check_tools.sh

kicad-setup:
	@scripts/setup_kicad_tools.sh

kicad-tools-check:
	@$(PYTHON) scripts/check_kicad_toolchain.py

e1-phone-schematic-scaffold:
	@$(PYTHON) scripts/generate_e1_phone_schematic.py

e1-phone-layout-metrics:
	@$(PYTHON) scripts/generate_e1_phone_layout_metrics.py

e1-phone-pcb-footprint-scaffold:
	@$(PYTHON) scripts/generate_e1_phone_pcb_footprint_scaffold.py

e1-phone-display-fit:
	@$(PYTHON) scripts/generate_e1_phone_display_fit.py

e1-phone-interface-closure:
	@$(PYTHON) scripts/generate_e1_phone_interface_closure.py

e1-phone-enclosure-placement:
	@$(PYTHON) scripts/generate_e1_phone_enclosure_placement_closure.py

e1-phone-power-thermal:
	@$(PYTHON) scripts/generate_e1_phone_power_thermal.py

e1-phone-pinout-footprint-freeze:
	@$(PYTHON) scripts/generate_e1_phone_pinout_footprint_freeze.py

e1-phone-audio-acoustic:
	@$(PYTHON) scripts/generate_e1_phone_audio_acoustic_closure.py

e1-phone-rf-connectivity:
	@$(PYTHON) scripts/generate_e1_phone_rf_connectivity.py

e1-phone-module-rf-pinout-execution:
	@$(PYTHON) scripts/generate_e1_phone_module_rf_pinout_execution.py

e1-phone-routed-pcb-implementation-execution:
	@$(PYTHON) scripts/generate_e1_phone_routed_pcb_implementation_execution.py

e1-phone-layout-optimization-execution:
	@$(PYTHON) scripts/generate_e1_phone_layout_optimization_execution.py

e1-phone-supplier-sourcing-audit:
	@$(PYTHON) scripts/generate_e1_phone_supplier_sourcing_audit.py

e1-phone-manufacturing-closure:
	@$(PYTHON) scripts/generate_e1_phone_manufacturing_closure.py

e1-phone-routed-release-plan:
	@$(PYTHON) scripts/generate_e1_phone_routed_release_plan.py

e1-phone-manufacturing-artifacts-check:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --manifest board/kicad/e1-phone/artifact-manifest.yaml

e1-phone-board-package-check:
	@$(PYTHON) scripts/check_e1_phone_board_package.py

kicad-phone-render: kicad-tools-check
	@scripts/kicad_docker.sh kicad-cli pcb export svg --output board/kicad/e1-phone/preview/kicad-cli-mainboard.svg --layers F.Cu,B.Cu,F.SilkS,F.Fab,Dwgs.User,Edge.Cuts --page-size-mode 2 --exclude-drawing-sheet --black-and-white board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb
	@scripts/kicad_docker.sh rsvg-convert --background-color white -o board/kicad/e1-phone/preview/kicad-cli-mainboard.png board/kicad/e1-phone/preview/kicad-cli-mainboard.svg
	@mkdir -p board/kicad/e1-phone/preview/schematic
	@scripts/kicad_docker.sh kicad-cli sch export svg --output board/kicad/e1-phone/preview/schematic --black-and-white --exclude-drawing-sheet board/kicad/e1-phone/schematic/e1-phone.kicad_sch
	@perl -pi -e 's/[ \t]+$$//' board/kicad/e1-phone/preview/kicad-cli-mainboard.svg board/kicad/e1-phone/preview/schematic/e1-phone.svg
	@scripts/kicad_docker.sh rsvg-convert --background-color white -o board/kicad/e1-phone/preview/schematic/e1-phone.png board/kicad/e1-phone/preview/schematic/e1-phone.svg
	@$(PYTHON) board/kicad/e1-phone/preview/verify-preview-assets.py

kicad-phone-preview-check:
	@$(PYTHON) board/kicad/e1-phone/preview/verify-preview-assets.py

phone-cad:
	@$(BENCH_PYTHON) scripts/generate_e1_phone_cad.py

phone-cad-test:
	@$(BENCH_PYTHON) -m pytest -q scripts/test_generate_e1_phone_cad.py

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

smoke: lint typecheck docs-check project-plan-check record-tool-versions mvp-npu-ml-evidence-check prototype-status-dashboard-check npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check soc-thermal-sweep soc-optimization soc-optimization-work-order cpu-npu-modeled-benchmark-eval cpu-npu-burst-sustained-policy cpu-npu-burst-thermal-transient cpu-npu-aosp-governor-trace cpu-npu-14a-process-eval cpu-npu-competitive-envelope cpu-npu-tapeout-readiness-audit cpu-npu-tapeout-readiness-audit-test cpu-npu-design-space-frontier cpu-npu-2028-readiness-scorecard cpu-npu-manual-review scale-feasibility-gate verification-maturity-matrix-check platform-contract-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check power-thermal-evidence-check power-thermal-evidence-test process-14a-effects-check process-14a-effects-test chipyard-generator-check cpu-ap-scaffold-check cpu-ap-evidence-test cpu-ap-completion-gate stub-audit bsp-scaffold-check software-bsp-check qemu-check renode-check benchmarks-dry-run rtl-check synth
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

benchmarks-local-host-evidence:
	@$(BENCH_PYTHON) scripts/run_local_benchmark_evidence.py --timeout-seconds 45 --require-pass

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

cpu-npu-tapeout-readiness-audit: cpu-npu-competitive-envelope benchmarks-dry-run npu-context-queue-sim-check memory-iommu-qos-sim-check
	@$(PYTHON) scripts/check_cpu_npu_tapeout_readiness_audit.py

cpu-npu-tapeout-readiness-audit-test:
	@$(PYTHON) scripts/test_cpu_npu_tapeout_readiness_audit.py

sota-parity-audit:
	@$(PYTHON) scripts/check_sota_parity_audit.py

sota-parity-audit-strict:
	@$(PYTHON) scripts/check_sota_parity_audit.py --strict

sota-parity-audit-test:
	@$(PYTHON) scripts/test_sota_parity_audit.py

tapeout-readiness: manufacturing-tapeout-scope-check
	@$(PYTHON) scripts/aggregate_tapeout_readiness.py

tapeout-readiness-strict: manufacturing-tapeout-scope-check
	@$(PYTHON) scripts/aggregate_tapeout_readiness.py --strict

tapeout-readiness-test:
	@$(PYTHON) scripts/test_aggregate_tapeout_readiness.py

# Unified chip + OS RV64 bring-up dashboard. The aggregator already
# carries the OS gates under subsystem=os_rv64; this target is just a
# friendly entry point that names the cross-package view explicitly so
# operators can spot it next to ``tapeout-readiness``. It is view-only
# and preserves the same ``claim_boundary`` as the chip aggregator.
chip-os-bring-up-status:
	@$(PYTHON) scripts/aggregate_tapeout_readiness.py

manufacturing-tapeout-scope-check:
	@$(PYTHON) scripts/check_manufacturing_tapeout_scope.py

manufacturing-tapeout-scope-test:
	@$(PYTHON) scripts/test_manufacturing_tapeout_scope.py

cpu-npu-design-space-frontier: soc-optimization
	@$(PYTHON) scripts/check_cpu_npu_design_space_frontier.py

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

benchmark-efficiency-scope-check:
	@$(PYTHON) scripts/check_benchmark_efficiency_scope.py

benchmark-efficiency-scope-test:
	@$(PYTHON) scripts/test_benchmark_efficiency_scope.py

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

cpu-npu-2028-readiness-scorecard: cpu-npu-tapeout-readiness-audit cpu-npu-design-space-frontier
	@$(PYTHON) scripts/check_cpu_npu_2028_readiness_scorecard.py

cpu-npu-2028-readiness-scorecard-test:
	@$(PYTHON) scripts/test_cpu_npu_2028_readiness_scorecard.py

cpu-npu-manual-review: cpu-npu-2028-readiness-scorecard
	@$(PYTHON) scripts/check_cpu_npu_manual_review.py

cpu-npu-manual-review-test:
	@$(PYTHON) scripts/test_cpu_npu_manual_review.py

power-thermal-scope-check:
	@$(PYTHON) scripts/check_power_thermal_scope.py

power-thermal-scope-test:
	@$(PYTHON) scripts/test_power_thermal_scope.py

power-thermal-evidence-check: power-thermal-scope-check
	@$(PYTHON) benchmarks/power/scripts/check_sustained_run_evidence.py benchmarks/power/manifests/e1-npu-sustained-capture.template.json --allow-blocked

power-thermal-evidence-test:
	@$(PYTHON) scripts/test_power_thermal_evidence.py

process-14a-effects-check:
	@$(PYTHON) scripts/check_process_14a_effects.py

process-14a-effects-test:
	@$(PYTHON) scripts/test_process_14a_effects.py

npu-scope-check:
	@$(PYTHON) scripts/check_npu_scope.py

npu-scope-test:
	@$(PYTHON) scripts/test_npu_scope.py

e1-npu-nnapi-proof-check: npu-scope-check
	@$(PYTHON) scripts/check_e1_npu_nnapi_proof.py --probe-adb

benchmarks: benchmark-efficiency-scope-check
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
	@$(PYTHON) scripts/test_aosp_simulator_completion_gate.py
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
	@$(PYTHON) scripts/test_chipyard_verilator_preflight.py
	@$(PYTHON) scripts/test_chipyard_verilator_linux_smoke.py
	@$(PYTHON) scripts/test_chipyard_verilator_smoke_robustness.py

chipyard-verilator-stale-path-repair:
	@$(PYTHON) scripts/check_chipyard_verilator_linux_smoke.py --repair-stale-generated

cpu-ap-scaffold-check:
	@$(PYTHON) scripts/check_cpu_ap_evidence.py

cpu-ap-scope-check:
	@$(PYTHON) scripts/check_cpu_ap_scope.py

cpu-ap-scope-test:
	@$(PYTHON) scripts/test_cpu_ap_scope.py

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

cpu-ap-evidence-check: cpu-ap-scope-check
	@$(PYTHON) scripts/check_cpu_ap_evidence.py --require-evidence

cpu-ap-evidence-test:
	@$(PYTHON) scripts/test_cpu_ap_evidence.py
	@$(PYTHON) scripts/test_cpu_ap_scope.py

cpu-ap-completion-gate: cpu-ap-scope-check
	@$(PYTHON) scripts/check_cpu_ap_completion_gate.py

.PHONY: core-selection-check core-selection-check-strict xiangshan-generator-check cva6-generator-check boom-generator-check ascalon-license-check linux-smoke linux-smoke-long linux-boot-check linux-boot-check-strict coremark embench jetstream spec-skeleton cocotb-cpu-extended pmu-event-alignment-check cpu-lint-check

core-selection-check:
	@$(PYTHON) scripts/check_core_selection.py

core-selection-check-strict:
	@$(PYTHON) scripts/check_core_selection.py --require-big-core-pin

xiangshan-generator-check:
	@$(PYTHON) scripts/check_xiangshan_pin.py

cva6-generator-check:
	@$(PYTHON) scripts/check_cva6_pin.py

boom-generator-check:
	@$(PYTHON) scripts/check_boom_pin.py

ascalon-license-check:
	@printf 'STATUS: BLOCKED cpu.ascalon_license - %s\n' \
	  'Tenstorrent Ascalon-D8 license + procurement required; see generators/chipyard/eliza-ascalon-manifest.json'

linux-smoke:
	@scripts/run_linux_smoke.sh

linux-smoke-long:
	@E1_LINUX_TIMEOUT_S=3600 E1_LINUX_MAX_CYCLES=400000000 scripts/run_linux_smoke.sh

linux-boot-check:
	@$(PYTHON) scripts/check_linux_boot.py

linux-boot-check-strict:
	@$(PYTHON) scripts/check_linux_boot.py --require

coremark:
	@scripts/run_coremark.sh

embench:
	@scripts/run_embench.sh

jetstream:
	@scripts/run_jetstream.sh

spec-skeleton:
	@scripts/run_spec.sh

cocotb-cpu-extended:
	@$(PYTHON) verify/cocotb/cpu/test_fusion_table.py
	@$(PYTHON) verify/cocotb/cpu/test_zihpm_event_table.py
	@$(PYTHON) verify/cocotb/cpu/test_csr_trap.py
	@$(PYTHON) verify/cocotb/cpu/test_mmu_sv39.py
	@$(PYTHON) scripts/check_pmu_event_alignment.py

pmu-event-alignment-check:
	@$(PYTHON) scripts/check_pmu_event_alignment.py

cpu-lint-check:
	@scripts/run_cpu_lint.sh

no-hardware-action-check:
	@$(PYTHON) scripts/check_no_hardware_action_matrix.py

memory-uma-claim-gate:
	@$(PYTHON) scripts/check_memory_uma_claim_gate.py

memory-evidence-template-check:
	@$(PYTHON) scripts/check_memory_evidence_templates.py

memory-interconnect-contract-check:
	@$(PYTHON) scripts/check_memory_interconnect_contract.py

memory-axi4-check:
	@$(PYTHON) scripts/check_axi4_burst.py
	@$(MAKE) -s cocotb-axi4
	@$(MAKE) -s cocotb-axi4-irq-w1c
	@$(MAKE) -s cocotb-axi4-multimaster
	@$(MAKE) -s cocotb-dram-ctrl
	@$(PYTHON) scripts/write_axi4_cocotb_status.py

iommu-evidence-check:
	@$(PYTHON) scripts/check_iommu_evidence.py

cocotb-axi4:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_axi4_burst \
	  COCOTB_TOPLEVEL=e1_axi4_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-axi4-irq-w1c:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_irq_w1c \
	  COCOTB_TOPLEVEL=e1_axi4_irq_w1c_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-axi4-multimaster:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_multi_master_fairness \
	  COCOTB_TOPLEVEL=e1_axi4_multimaster_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-dram-ctrl:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_dfi_traffic \
	  COCOTB_TOPLEVEL=e1_dram_ctrl_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-axi4-width-converter:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_width_converter \
	  COCOTB_TOPLEVEL=e1_axi4_width_converter_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-iommu:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_riscv_iommu \
	  COCOTB_TOPLEVEL=e1_iommu_tb COCOTB_DIR=verify/cocotb/iommu \
	  scripts/run_cocotb.sh

.PHONY: cocotb-soc-boot-smoke cocotb-cross-domain cocotb-opensbi-mpxy-rpmi soc-integration-check cocotb-cva6-cpu cocotb-cva6-cpu-bootrom cocotb-cva6-cpu-dram cocotb-cva6-soc

cocotb-soc-boot-smoke:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_soc_boot_smoke \
	  COCOTB_TOPLEVEL=e1_soc_integrated_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  scripts/run_cocotb.sh

cocotb-cross-domain:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_cross_domain_interfaces \
	  COCOTB_TOPLEVEL=e1_soc_integrated_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  scripts/run_cocotb.sh

# OpenSBI MPxy -> RPMI shmem -> AON Ibex PMC roundtrip.  Reports BLOCKED
# skips by default; pass PMC_INSTANTIATE_IBEX=1 and PMC_RPMI_SHMEM_ROUNDTRIP=1
# (and PMC_AON_SRAM_HEX=...) once the three remaining RTL/firmware bindings
# tracked in docs/evidence/power/pmc-soc-integration-evidence.yaml::
# mpxy_rpmi_roundtrip.remaining_bindings have landed.
cocotb-opensbi-mpxy-rpmi:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_opensbi_mpxy_to_pmc_rpmi \
	  COCOTB_TOPLEVEL=e1_soc_integrated_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  scripts/run_cocotb.sh

soc-integration-check: cocotb-soc-boot-smoke cocotb-cross-domain cocotb-opensbi-mpxy-rpmi
	@$(PYTHON) scripts/check_soc_integration.py

# ---------------------------------------------------------------------------
# Standalone CVA6 wrapper integration (rtl/cpu/e1_cva6_wrapper.sv +
# rtl/top/adapters/e1_cva6_to_e1axi4.sv) — links the full CVA6 source
# tree from external/cva6/cva6/ via core/Flist.cva6 (pinned to upstream
# master HEAD via external/cva6/pin-manifest.json).  Kept separate
# from the lite-mode integration suite so the existing 18 cocotb tests
# stay independent of the CVA6 pin.
# ---------------------------------------------------------------------------
cocotb-cva6-cpu-bootrom:
	@scripts/apply_cva6_patches.sh
	@PYTHON=$(COCOTB_PYTHON) \
	  CVA6_VERILATOR_FULL_OK=1 \
	  COCOTB_MODULE=test_cva6_executes_bootrom_program \
	  COCOTB_TOPLEVEL=e1_cva6_unit_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  COCOTB_MAKEFILE=Makefile.cva6 \
	  scripts/run_cocotb.sh

cocotb-cva6-cpu-dram:
	@scripts/apply_cva6_patches.sh
	@PYTHON=$(COCOTB_PYTHON) \
	  CVA6_VERILATOR_FULL_OK=1 \
	  COCOTB_MODULE=test_cva6_dram_read_write \
	  COCOTB_TOPLEVEL=e1_cva6_unit_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  COCOTB_MAKEFILE=Makefile.cva6 \
	  scripts/run_cocotb.sh

cocotb-cva6-cpu: cocotb-cva6-cpu-bootrom cocotb-cva6-cpu-dram
	@echo "cocotb-cva6-cpu complete (local btb V3Delayed patch applied via scripts/apply_cva6_patches.sh)"

# In-band CVA6 SoC boot test.  Compiles `e1_soc_integrated` with
# `+define+E1_HAVE_CVA6 +define+E1_CLUSTER_SLOT0_CVA6` so the
# `u_cva6_slot0` wrapper inside the SoC top instantiates the real CVA6
# v5.3.0 core and the slot-0 memory model serves the boot-ROM + DRAM
# traffic through the 64↔128 AXI4 width converter.  Exercises the
# integrated cluster_to_fabric edge end-to-end (vs. the standalone
# wrapper TB).
cocotb-cva6-soc:
	@scripts/apply_cva6_patches.sh
	@PYTHON=$(COCOTB_PYTHON) \
	  CVA6_VERILATOR_FULL_OK=1 \
	  COCOTB_MODULE=test_cva6_boots_in_soc \
	  COCOTB_TOPLEVEL=e1_soc_integrated_tb \
	  COCOTB_DIR=verify/cocotb/integration \
	  COCOTB_MAKEFILE=Makefile.cva6-soc \
	  scripts/run_cocotb.sh

stream-bench:
	@$(MAKE) -C benchmarks/memory/stream run \
	  || $(MAKE) -C benchmarks/memory/stream blocked-evidence

lmbench-bw:
	@$(MAKE) -C benchmarks/memory/lmbench run \
	  || $(MAKE) -C benchmarks/memory/lmbench blocked-evidence

mlc-bench:
	@$(MAKE) -C benchmarks/memory/mlc run \
	  || $(MAKE) -C benchmarks/memory/mlc blocked-evidence

dma-buf-negative:
	@$(MAKE) -C benchmarks/memory/dma_buf_negative run \
	  || $(MAKE) -C benchmarks/memory/dma_buf_negative blocked-evidence

dramsim-sweep:
	@$(PYTHON) -m compiler.runtime.dramsim_wrap.runner

npu-2028-target-check:
	@$(PYTHON) scripts/check_npu_2028_targets.py

cpu-2028-target-check:
	@$(PYTHON) scripts/check_cpu_2028_target.py

memory-2028-target-check:
	@$(PYTHON) scripts/check_memory_2028_target.py

memory-iommu-qos-sim-check:
	@$(PYTHON) scripts/check_memory_iommu_qos_sim.py

memory-iommu-qos-sim-test:
	@$(PYTHON) scripts/test_memory_iommu_qos_sim.py

security-2028-target-check:
	@$(PYTHON) scripts/check_security_2028_target.py

pd-util-check:
	@$(PYTHON) scripts/check_pd_utilization.py

spec-check-tests:
	@$(PYTHON) -m unittest scripts.test_check_cpu_2028_target scripts.test_check_memory_2028_target scripts.test_check_security_2028_target scripts.test_check_pd_utilization

npu-regmap-cross-check:
	@$(PYTHON) scripts/check_e1_npu_regmap_cross_check.py

power-thermal-projection:
	@$(PYTHON) scripts/power_thermal_model.py --report

power-thermal-projection-check:
	@$(PYTHON) scripts/power_thermal_model.py --check

power-thermal-projection-test:
	@$(PYTHON) -m unittest scripts.test_power_thermal_model

npu-runtime-contract-check:
	@$(PYTHON) scripts/check_e1_npu_runtime_contract.py

npu-roadmap-check:
	@$(PYTHON) scripts/check_npu_roadmap.py

npu-open-scale-model-check:
	@$(PYTHON) scripts/check_npu_open_scale_model.py

npu-scale-sim-check:
	@$(PYTHON) scripts/check_npu_scale_sim.py

npu-context-queue-sim-check:
	@$(PYTHON) scripts/check_npu_context_queue_sim.py

npu-context-queue-sim-test:
	@$(PYTHON) scripts/test_npu_context_queue_sim.py

scale-feasibility-gate:
	@$(PYTHON) scripts/check_scale_feasibility_gate.py

verification-maturity-matrix-check:
	@$(PYTHON) scripts/check_verification_maturity_matrix.py

product-check: pinout-check fpga-check wifi-interface-check padframe-check board-package-evidence-check e1-phone-board-package-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check pd-signoff-manifest-check manufacturing-artifacts-check real-world-gates-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check product-feature-gates-check
	@$(PYTHON) scripts/product_check.py

product-check-status-test:
	@$(PYTHON) scripts/test_product_check_status.py

product-release-check: pinout-check fpga-check wifi-interface-check padframe-check board-package-evidence-check e1-phone-board-package-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check pd-signoff-manifest-check manufacturing-artifacts-check real-world-gates-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check product-feature-gates-check
	@$(PYTHON) scripts/product_check.py --release

product-evidence-commands:
	@$(PYTHON) scripts/run_product_evidence_command.py --list

product-resolved-manifest:
	@$(PYTHON) scripts/check_manufacturing_artifacts.py --resolved-manifest build/reports/manufacturing-resolved-artifacts.json

project-plan-check:
	@$(PYTHON) scripts/check_project_plan.py

prototype-status-dashboard-check:
	@$(PYTHON) scripts/check_prototype_status_dashboard.py

phone-soc-claim-check: phone-media-pipeline-scope-check
	@$(PYTHON) scripts/check_phone_soc_claims.py

phone-media-pipeline-scope-check:
	@$(PYTHON) scripts/check_phone_media_pipeline_scope.py

phone-media-pipeline-scope-test:
	@$(PYTHON) scripts/test_phone_media_pipeline_scope.py

security-lifecycle-scope-check:
	@$(PYTHON) scripts/check_security_lifecycle_scope.py

security-lifecycle-scope-test:
	@$(PYTHON) scripts/test_security_lifecycle_scope.py

product-feature-gates-check: security-lifecycle-scope-check
	@$(PYTHON) scripts/check_product_feature_gates.py

pinout-check:
	@$(PYTHON) package/scripts/validate_pinout.py package/e1-demo-pinout.yaml

# ----- Power delivery / DVFS / PMC targets -------------------------------
rail-plan-check:
	@$(PYTHON) scripts/check_rail_plan.py

upf-check:
	@$(PYTHON) scripts/check_upf_consistency.py

pdn-workload-signoff:
	@$(PYTHON) scripts/check_pdn_workload_signoff.py

pmic-procurement-gate:
	@$(PYTHON) scripts/check_pdn_workload_signoff.py --allow-blocked

cocotb-droop:
	@COCOTB_DIR=verify/cocotb/power COCOTB_TOPLEVEL=droop_stretch_tb \
	    COCOTB_MODULE=test_droop_event PYTHON=$(VENV_PYTHON) \
	    scripts/run_cocotb.sh

cocotb-clock-stretcher: cocotb-droop

cocotb-avfs:
	@COCOTB_DIR=verify/cocotb/power COCOTB_TOPLEVEL=avfs_ctrl \
	    COCOTB_MODULE=test_avfs_convergence PYTHON=$(VENV_PYTHON) \
	    scripts/run_cocotb.sh

cocotb-pmc:
	@COCOTB_DIR=verify/cocotb/power COCOTB_TOPLEVEL=pmc_top \
	    COCOTB_MODULE=test_pmc_mailbox PYTHON=$(VENV_PYTHON) \
	    scripts/run_cocotb.sh

cocotb-power: cocotb-droop cocotb-avfs cocotb-pmc

fw-pmc-build:
	@$(MAKE) -C fw/pmc all
	@$(MAKE) -C fw/pmc test
	@$(MAKE) -C fw/pmc elf
	@$(MAKE) -C fw/pmc sim-elf


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

radio-sensor-pmic-scope-check:
	@$(PYTHON) scripts/check_radio_sensor_pmic_scope.py

radio-sensor-pmic-scope-test:
	@$(PYTHON) scripts/test_radio_sensor_pmic_scope.py

real-world-gates-check: radio-sensor-pmic-scope-check
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

# ---------------------------------------------------------------------------
# PD evidence gates: macro placement, DFT, CTS, multi-corner STA, post-route
# PPA validator, and commercial-EDA partnership gate.
# All six fail closed until the underlying artifacts land.
# ---------------------------------------------------------------------------
.PHONY: pd-evidence-gates autotuner-sweep alphachip-post-route dreamplace-eval \
        multi-corner-sta dft-scan-insert commercial-eda-gate

pd-evidence-gates:
	@$(PYTHON) scripts/check_pd_evidence_gates.py

autotuner-sweep:
	@$(PYTHON) scripts/openroad_autotuner.py \
	    --sweep-id $${SWEEP_ID:?set SWEEP_ID=<id>} \
	    --trials $${TRIALS:-32} \
	    $${AUTOTUNER_EXTRA_ARGS:-}

alphachip-post-route:
	@$(PYTHON) scripts/run_post_route_ppa.py \
	    --plc $${ALPHACHIP_PLC:?set ALPHACHIP_PLC=<path/to/alphachip.plc>} \
	    --netlist $${NETLIST:?set NETLIST=<path/to/e1_softmacro.pb.txt>} \
	    --openroad-run-dir $${OPENROAD_RUN_DIR:?set OPENROAD_RUN_DIR=<pd/openlane/runs/RUN_...>} \
	    --openlane-config $${OPENLANE_CONFIG:-pd/openlane/config.sky130.json} \
	    --out-json $${OUT_JSON:-research/alpha_chip_macro_placement/07_post_route_ppa/alphachip.json} \
	    $${POST_ROUTE_EXTRA_ARGS:-}

dreamplace-eval:
	@$(PYTHON) scripts/dreamplace_eval.py \
	    --bench-dir $${BENCH_DIR:?set BENCH_DIR=<path>} \
	    --out-dir $${OUT_DIR:-build/pd/dreamplace} \
	    $${DREAMPLACE_EXTRA_ARGS:-}

multi-corner-sta:
	@$(PYTHON) scripts/run_multi_corner_sta.py \
	    --run-dir $${RUN_DIR:?set RUN_DIR=<pd/openlane/runs/RUN_...>} \
	    --out-dir $${OUT_DIR:-build/pd/multi_corner_sta} \
	    --pdk-root $${PDK_ROOT:?set PDK_ROOT=<sky130A install>} \
	    $${STA_EXTRA_ARGS:-}

dft-scan-insert:
	@mkdir -p build/dft
	@if ! command -v yosys >/dev/null 2>&1; then \
	    echo "BLOCK: yosys missing; cannot run scan insertion"; exit 1; \
	fi
	@yosys -p "read_verilog -sv $(RTL_SRCS); \
	    hierarchy -top $(RTL_TOP); \
	    synth -top $(RTL_TOP); \
	    source pd/dft/scan_insertion.tcl; \
	    write_verilog build/dft/$(RTL_TOP).scan.v"
	@echo "PASS: scan-inserted netlist written: build/dft/$(RTL_TOP).scan.v"

commercial-eda-gate:
	@$(PYTHON) scripts/check_commercial_eda_gate.py

openlane-orchestration-test:
	@$(PYTHON) scripts/test_openlane_orchestration.py

bootrom-check:
	@$(PYTHON) fw/boot-rom/check_boot_rom.py

cdc-rdc-intent-check:
	@$(PYTHON) scripts/check_cdc_rdc_intent.py

waveform-debug-policy-check:
	@$(PYTHON) scripts/check_waveform_debug_policy.py

external-model-corpus-intake-policy-check:
	@$(PYTHON) scripts/check_external_model_corpus_intake_policy.py

analog-automation-policy-check:
	@$(PYTHON) scripts/check_analog_automation_policy.py

hardware-security-ai-policy-check:
	@$(PYTHON) scripts/check_hardware_security_ai_policy.py

dft-atpg-policy-check:
	@$(PYTHON) scripts/check_dft_atpg_policy.py

power-thermal-ai-policy-check:
	@$(PYTHON) scripts/check_power_thermal_ai_policy.py

software-bsp-firmware-ai-policy-check:
	@$(PYTHON) scripts/check_software_bsp_firmware_ai_policy.py

spec-traceability-ai-policy-check:
	@$(PYTHON) scripts/check_spec_traceability_ai_policy.py

rtl-check:
	@scripts/run_rtl_check.sh

stub-audit:
	@$(PYTHON) verify/check_stub_audit.py

cocotb:
	@PYTHON=$(COCOTB_PYTHON) scripts/run_cocotb.sh

cocotb-npu:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_e1_npu COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh

cocotb-npu-tiny-mlp-e2e:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/npu COCOTB_MODULE=test_iree_tiny_mlp_e2e COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh

cocotb-contract:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_cpu_mem_intc_contract COCOTB_TOPLEVEL=e1_linux_soc_contract scripts/run_cocotb.sh

cocotb-cpu:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_tiny_cpu_execution COCOTB_TOPLEVEL=e1_tiny_cpu_contract_tb scripts/run_cocotb.sh

.PHONY: cocotb-coverage
cocotb-coverage: cocotb cocotb-npu
	@$(PYTHON) scripts/check_cocotb_coverage.py --require-blocks

.PHONY: cocotb-bpu cocotb-bpu-ras cocotb-bpu-ftq cocotb-bpu-ftb cocotb-bpu-uftb cocotb-bpu-loop cocotb-bpu-tage cocotb-bpu-ittage cocotb-bpu-sc formal-bpu branch-prediction-check mpki-eval mpki-eval-rtl mpki-eval-model bpu-lint

cocotb-bpu: cocotb-bpu-ras cocotb-bpu-ftq cocotb-bpu-ftb cocotb-bpu-uftb cocotb-bpu-loop cocotb-bpu-tage cocotb-bpu-ittage cocotb-bpu-sc
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_bpu_top COCOTB_TOPLEVEL=bpu_top_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-tage:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_tage COCOTB_TOPLEVEL=tage_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-ittage:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_ittage COCOTB_TOPLEVEL=ittage_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-sc:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_sc COCOTB_TOPLEVEL=sc_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-ras:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_ras COCOTB_TOPLEVEL=ras_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-ftq:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_ftq COCOTB_TOPLEVEL=ftq_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-ftb:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_ftb COCOTB_TOPLEVEL=ftb_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-uftb:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_uftb COCOTB_TOPLEVEL=uftb_tb scripts/run_cocotb_bpu.sh

cocotb-bpu-loop:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/bpu COCOTB_MODULE=test_loop_predictor COCOTB_TOPLEVEL=loop_predictor_tb scripts/run_cocotb_bpu.sh

formal-bpu:
	@scripts/run_formal_bpu.sh

branch-prediction-check:
	@$(PYTHON) scripts/check_branch_prediction.py --require-clean

bpu-lint:
	@scripts/run_bpu_lint.sh

mpki-eval:
	@PYTHON=$(COCOTB_PYTHON) $(PYTHON) benchmarks/cpu/branch/run_mpki.py --backend auto

mpki-eval-rtl:
	@PYTHON=$(COCOTB_PYTHON) $(PYTHON) benchmarks/cpu/branch/run_mpki.py --backend rtl

mpki-eval-model:
	@$(PYTHON) benchmarks/cpu/branch/run_mpki.py --backend model

.PHONY: cache-hierarchy-claim-gate cocotb-cache cocotb-cache-coherence \
	cocotb-cache-l1d cocotb-cache-l1i cocotb-cache-drrip \
	cocotb-cache-stride cocotb-cache-bdi cocotb-cache-bdi-roundtrip \
	cocotb-cache-berti cocotb-cache-ipcp cocotb-cache-spp \
	cocotb-cache-best-offset cocotb-cache-fdip cocotb-cache-hawkeye \
	cocotb-cache-mockingjay cocotb-cache-mockingjay-accuracy \
	cocotb-cache-coherence-vectors cocotb-cache-moesi-dirty-shared \
	formal-cache champsim-prefetch-sweep mockingjay-vs-lru-sweep \
	lmbench-cache-curve stream-cache-bench pointer-chase-cache-bench

cache-hierarchy-claim-gate:
	@$(PYTHON) scripts/check_cache_hierarchy.py

cocotb-cache: cocotb-cache-l1d cocotb-cache-l1i cocotb-cache-drrip \
	cocotb-cache-stride cocotb-cache-bdi cocotb-cache-bdi-roundtrip \
	cocotb-cache-berti cocotb-cache-ipcp cocotb-cache-spp \
	cocotb-cache-best-offset cocotb-cache-fdip cocotb-cache-hawkeye \
	cocotb-cache-mockingjay cocotb-cache-coherence-vectors \
	cocotb-cache-moesi-dirty-shared

cocotb-cache-coherence: cocotb-cache-coherence-vectors cocotb-cache-moesi-dirty-shared

cocotb-cache-l1d:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_l1d_basic COCOTB_TOPLEVEL=e1_l1d_cache \
	  scripts/run_cocotb_cache.sh

cocotb-cache-l1i:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_l1i_basic COCOTB_TOPLEVEL=e1_l1i_cache \
	  scripts/run_cocotb_cache.sh

cocotb-cache-drrip:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_drrip COCOTB_TOPLEVEL=e1_drrip \
	  scripts/run_cocotb_cache.sh

cocotb-cache-stride:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_stride_prefetcher COCOTB_TOPLEVEL=e1_stride_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-bdi:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_bdi_compression COCOTB_TOPLEVEL=e1_bdi_compress \
	  scripts/run_cocotb_cache.sh

cocotb-cache-bdi-roundtrip:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_bdi_roundtrip COCOTB_TOPLEVEL=e1_bdi_decompress \
	  scripts/run_cocotb_cache.sh

cocotb-cache-berti:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_berti_prefetcher COCOTB_TOPLEVEL=e1_berti_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-ipcp:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_ipcp_prefetcher COCOTB_TOPLEVEL=e1_ipcp_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-spp:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_spp_prefetcher COCOTB_TOPLEVEL=e1_spp_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-best-offset:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_best_offset_prefetcher \
	  COCOTB_TOPLEVEL=e1_best_offset_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-fdip:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_fdip_prefetcher \
	  COCOTB_TOPLEVEL=e1_fdip_l1i_prefetcher \
	  scripts/run_cocotb_cache.sh

cocotb-cache-hawkeye:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_hawkeye COCOTB_TOPLEVEL=e1_hawkeye \
	  scripts/run_cocotb_cache.sh

cocotb-cache-mockingjay:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_mockingjay COCOTB_TOPLEVEL=e1_mockingjay \
	  scripts/run_cocotb_cache.sh

cocotb-cache-mockingjay-accuracy:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_mockingjay_accuracy \
	  COCOTB_TOPLEVEL=e1_mockingjay_prod_tb \
	  scripts/run_cocotb_cache.sh

cocotb-cache-coherence-vectors:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_coherence_vectors COCOTB_TOPLEVEL=e1_l1d_cache \
	  scripts/run_cocotb_cache.sh

cocotb-cache-moesi-dirty-shared:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_moesi_dirty_shared COCOTB_TOPLEVEL=e1_l3_tb \
	  scripts/run_cocotb_cache.sh

formal-cache:
	@scripts/run_formal_cache.sh

champsim-prefetch-sweep:
	@$(PYTHON) scripts/champsim_sweep.py --mode prefetch --commit-evidence || \
	  ($(PYTHON) scripts/champsim_sweep.py --mode prefetch --blocked-evidence)

mockingjay-vs-lru-sweep:
	@$(PYTHON) scripts/champsim_sweep.py --mode mockingjay-vs-lru --commit-evidence || \
	  ($(PYTHON) scripts/champsim_sweep.py --mode mockingjay-vs-lru --blocked-evidence)

lmbench-cache-curve:
	@$(PYTHON) benchmarks/cpu/cache/lmbench_cache_curve.py --allow-missing-tool

stream-cache-bench:
	@$(PYTHON) benchmarks/cpu/cache/stream_cache_bench.py --allow-missing-tool

pointer-chase-cache-bench:
	@$(PYTHON) benchmarks/cpu/cache/pointer_chase_bench.py --emit-stub

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

.PHONY: pdk-portability-check pdk-portability-test pdk-access-gate ppa-projection die-area-budget-check asap7-flow ihp-sg13g2-flow

pdk-portability-check:
	@$(PYTHON) scripts/check_pdk_portability.py

pdk-portability-test:
	@$(PYTHON) scripts/test_pdk_portability.py

pdk-access-gate: pdk-portability-check
	@if [ ! -f docs/evidence/process/pdk-access-gate.yaml ]; then \
	    echo "BLOCK: docs/evidence/process/pdk-access-gate.yaml missing"; exit 1; \
	fi
	@echo "PDK access gate evidence file present: docs/evidence/process/pdk-access-gate.yaml"
	@echo "Advanced-node access is blocked_until_foundry_agreement (see file)."

ppa-projection: pdk-portability-check
	@$(PYTHON) scripts/project_ppa_to_n2p.py

die-area-budget-check:
	@$(PYTHON) scripts/check_die_area_budget.py

asap7-flow:
	@$(MAKE) -C pd/asap7 all

ihp-sg13g2-flow:
	@OPENLANE_CONFIG=pd/openlane/config.ihp-sg13g2.json scripts/run_openlane.sh --release

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

renode-check: platform-contract-check qemu-check
	@scripts/run_renode.sh --check

renode-check-strict: platform-contract-check qemu-check
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

buildroot-qemu-virt-smoke:
	@sw/buildroot/scripts/capture-buildroot-qemu-virt-smoke.sh

buildroot-qemu-virt-smoke-test:
	@$(PYTHON) -m unittest sw.buildroot.scripts.test_capture_buildroot_qemu_virt_smoke

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

# Cuttlefish riscv64 AOSP build pipeline. Hosts that pass `aosp-build-preflight`
# can directly invoke `aosp-build-riscv64`; CI and unsupported distros should
# run the build inside the Docker image at sw/aosp-device/Dockerfile (see
# docs/android/aosp-build-operator-guide.md).
aosp-build-preflight:
	@if [ -z "$${AOSP_WORKSPACE:-}" ]; then \
		echo "STATUS: BLOCKED aosp.build-preflight - set AOSP_WORKSPACE=/path/to/aosp-workspace"; \
		exit 0; \
	fi; \
	sw/aosp-device/build-aosp-riscv64.sh \
		--workspace "$$AOSP_WORKSPACE" \
		--skip-sync --skip-build

aosp-build-riscv64:
	@if [ -z "$${AOSP_WORKSPACE:-}" ]; then \
		echo "STATUS: BLOCKED aosp.build-riscv64 - set AOSP_WORKSPACE=/path/to/aosp-workspace"; \
		exit 0; \
	fi; \
	sw/aosp-device/build-aosp-riscv64.sh \
		--workspace "$$AOSP_WORKSPACE" \
		$${AOSP_BRANCH:+--branch $$AOSP_BRANCH} \
		$${AOSP_LUNCH:+--lunch-target $$AOSP_LUNCH} \
		$${AOSP_JOBS:+--jobs $$AOSP_JOBS} \
		$${AOSP_OVERLAY_MODE:+--device-overlay-mode $$AOSP_OVERLAY_MODE}

bsp-scaffold-check:
	@$(PYTHON) sw/check_bsp_scaffolds.py all

software-bsp-check:
	@$(PYTHON) scripts/check_software_bsp.py all

software-bsp-scaffold-check:
	@$(PYTHON) scripts/check_software_bsp.py all --scaffold-only

software-bsp-scope-check:
	@$(PYTHON) scripts/check_software_bsp_scope.py

software-bsp-scope-test:
	@$(PYTHON) scripts/test_software_bsp_scope.py

software-bsp-external-preflight:
	@$(PYTHON) scripts/check_software_bsp.py external-preflight all --write-report

software-bsp-evidence-check: software-bsp-scope-check
	@$(PYTHON) scripts/check_software_bsp.py all --require-evidence

software-bsp-test:
	@$(PYTHON) scripts/test_software_bsp_checks.py
	@$(PYTHON) scripts/test_software_bsp_evidence.py
	@$(PYTHON) scripts/test_software_bsp_scope.py

evidence-regression-test: no-hardware-action-check software-bsp-test physical-gates-test product-feature-gates-check product-check-status-test benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test benchmark-efficiency-scope-test software-bsp-scope-test cpu-ap-scope-test npu-scope-test renode-status-test cocotb cocotb-npu cocotb-contract cocotb-cpu record-tool-versions strict-release-gate-test
	@echo "evidence regression tests complete"

.PHONY: ai-eda-source-inventory-check ai-eda-ai-workload-manifest-check ai-eda-assertion-candidate-manifests-check \
	ai-eda-external-assets-check ai-eda-external-intake-check \
	ai-eda-external-assets-dry-run ai-eda-local-rag-index ai-eda-backend-preflight \
	ai-eda-bootstrap-metadata ai-eda-bootstrap-setup-check ai-eda-bootstrap-local-smoke \
	ai-eda-bootstrap-training-handoff ai-eda-alphachip-checkpoint-blocker-check \
	ai-eda-alphachip-checkpoint-blocker-network-check ai-eda-external-method-wrapper-readiness-check ai-eda-internal-schemas-check \
	ai-eda-internal-fixtures ai-eda-openroad-eda-corpus-convert ai-eda-tilos-macroplacement-convert \
	ai-eda-circuitnet3-convert ai-eda-chipbench-d-convert ai-eda-aieda-idata-convert \
	ai-eda-edalearn-convert ai-eda-macro-place-challenge-convert ai-eda-mlcad-fpga-macro-convert \
	ai-eda-research-code-assets-convert ai-eda-current-research-watchlist-convert ai-eda-circuitnet3-surrogate \
	ai-eda-openabc-d-convert ai-eda-e1-softmacro-cases ai-eda-external-fixture-convert ai-eda-e1-openlane-convert \
	ai-eda-training-corpus-manifest \
	ai-eda-openlane-flow-labels ai-eda-openroad-ml-snapshot ai-eda-pd-surrogate-smoke ai-eda-fixture-placement-train \
	ai-eda-macro-placement-supervised-dataset ai-eda-macro-placement-supervised-train \
	ai-eda-macro-placement-torch-train ai-eda-macro-placement-torch-infer \
	ai-eda-macro-placement-supervised-replay-plan ai-eda-macro-placement-baseline \
	ai-eda-macro-placement-candidate-eval ai-eda-macro-placement-combined-candidate-eval \
	ai-eda-macro-placement-full-candidate-eval ai-eda-macro-placement-replay-plan \
	ai-eda-macro-placement-replay-preflight ai-eda-macro-placement-combined-replay-plan \
	ai-eda-macro-placement-full-replay-plan ai-eda-macro-placement-replay-queue ai-eda-candidate-manifests-check \
	ai-eda-tool-actions-check ai-eda-cocotb-stimulus-dry-run ai-eda-verification-targets \
	ai-eda-physical-design-targets ai-eda-optimization-targets ai-eda-all-target-captures ai-eda-logic-synthesis-recipes \
	ai-eda-logic-synthesis-baseline ai-eda-cuda-preflight ai-eda-cuda-payload \
	ai-eda-cuda-payload-check ai-eda-cuda-run-plan-dry-run ai-eda-cuda-run-plan-safety-matrix ai-eda-cuda-readiness-audit
ai-eda-source-inventory-check:
	@AI_EDA_RUN_ID=$(AI_EDA_RUN_ID) $(PYTHON) scripts/check_ai_eda_source_inventory.py

ai-eda-ai-workload-manifest-check:
	@$(PYTHON) scripts/ai_eda/check_ai_workload_manifest.py

ai-eda-assertion-candidate-manifests-check:
	@$(PYTHON) scripts/ai_eda/check_assertion_candidate_manifests.py

ai-eda-external-assets-check:
	@$(PYTHON) scripts/ai_eda/check_external_asset_manifests.py

ai-eda-external-intake-check: ai-eda-external-assets-check
	@$(PYTHON) scripts/ai_eda/check_external_intake_manifests.py --run-id $(AI_EDA_RUN_ID)

ai-eda-external-assets-dry-run:
	@$(PYTHON) scripts/ai_eda/fetch_external_asset.py --all --dry-run --run-id $(AI_EDA_RUN_ID)

ai-eda-local-rag-index:
	@$(PYTHON) scripts/ai_eda/build_local_eda_rag_index.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_local_eda_rag_index.py

ai-eda-backend-preflight:
	@$(PYTHON) scripts/ai_eda/preflight_ai_eda_backends.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_backend_preflight.py --report build/ai_eda/backend_preflight/$(AI_EDA_RUN_ID)/backend_preflight_report.json

ai-eda-bootstrap-metadata:
	@$(PYTHON) scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id $(AI_EDA_RUN_ID)

ai-eda-bootstrap-setup-check:
	@$(PYTHON) scripts/ai_eda/bootstrap_ai_eda_stack.py --profile setup-check --run-id $(AI_EDA_RUN_ID) --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026

ai-eda-bootstrap-local-smoke:
	@$(PYTHON) scripts/ai_eda/bootstrap_ai_eda_stack.py --profile local-smoke --run-id $(AI_EDA_RUN_ID) --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026

ai-eda-bootstrap-training-handoff:
	@$(PYTHON) scripts/ai_eda/bootstrap_ai_eda_stack.py --profile training-handoff --run-id $(AI_EDA_RUN_ID)-training-handoff --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026 --include-torch

ai-eda-alphachip-checkpoint-blocker-check:
	@$(PYTHON) scripts/ai_eda/check_alphachip_checkpoint_blocker.py --run-id $(AI_EDA_RUN_ID)

ai-eda-alphachip-checkpoint-blocker-network-check:
	@$(PYTHON) scripts/ai_eda/check_alphachip_checkpoint_blocker.py --run-id $(AI_EDA_RUN_ID) --network

ai-eda-external-method-wrapper-readiness-check:
	@$(PYTHON) scripts/ai_eda/check_external_method_wrapper_readiness.py

ai-eda-internal-schemas-check:
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py

ai-eda-internal-fixtures: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/materialize_internal_dataset_fixtures.py --run-id $(AI_EDA_RUN_ID)

ai-eda-openroad-eda-corpus-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_openroad_eda_corpus.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/openroad_eda_corpus/$(AI_EDA_RUN_ID)/records

ai-eda-tilos-macroplacement-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_tilos_macroplacement.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/tilos_macroplacement/$(AI_EDA_RUN_ID)/records

ai-eda-circuitnet3-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_circuitnet3_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 16
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/circuitnet3/$(AI_EDA_RUN_ID)/records

ai-eda-chipbench-d-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_chipbench_d_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 4
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/chipbench_d/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_chipbench_d_conversion.py --report build/ai_eda/chipbench_d/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-aieda-idata-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 3
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/aieda_idata/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_aieda_idata_conversion.py --report build/ai_eda/aieda_idata/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-edalearn-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 8
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/edalearn/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_edalearn_conversion.py --report build/ai_eda/edalearn/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-macro-place-challenge-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 4
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/macro_place_challenge_2026/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_macro_place_challenge_2026_conversion.py --report build/ai_eda/macro_place_challenge_2026/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-mlcad-fpga-macro-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_mlcad_2023_fpga_macro_to_internal_records.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/mlcad_2023_fpga_macro/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_mlcad_2023_fpga_macro_conversion.py --report build/ai_eda/mlcad_2023_fpga_macro/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-research-code-assets-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/research_code_assets/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_research_code_assets_conversion.py --report build/ai_eda/research_code_assets/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-current-research-watchlist-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/current_research_watchlist_records/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_current_research_watchlist_records.py --report build/ai_eda/current_research_watchlist_records/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-circuitnet3-surrogate: ai-eda-circuitnet3-convert
	@$(PYTHON) scripts/ai_eda/train_circuitnet3_timing_power_baseline.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_circuitnet3_surrogate.py --report build/ai_eda/circuitnet3_surrogate/$(AI_EDA_RUN_ID)/training_run.json

ai-eda-openabc-d-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_openabc_d_to_internal_records.py --run-id $(AI_EDA_RUN_ID) --sample-limit 2
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/openabc_d/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_openabc_d_conversion.py --report build/ai_eda/openabc_d/$(AI_EDA_RUN_ID)/conversion_report.json

ai-eda-e1-softmacro-cases: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/materialize_e1_softmacro_cases.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/e1_softmacro_cases/$(AI_EDA_RUN_ID)/records

ai-eda-external-fixture-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_external_fixture_corpora.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/converted_external_fixtures/$(AI_EDA_RUN_ID)/records

ai-eda-e1-openlane-convert: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/convert_e1_openlane_to_internal_records.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/e1_openlane_conversion/$(AI_EDA_RUN_ID)/records

ai-eda-openlane-flow-labels: ai-eda-e1-openlane-convert
	@$(PYTHON) scripts/ai_eda/parse_openlane_metrics_to_flow_run.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_internal_dataset_schemas.py --records-dir build/ai_eda/openlane_flow_labels/$(AI_EDA_RUN_ID)/records
	@$(PYTHON) scripts/ai_eda/check_openlane_flow_labels.py --report build/ai_eda/openlane_flow_labels/$(AI_EDA_RUN_ID)/label-parse-report.json

ai-eda-training-corpus-manifest: ai-eda-internal-fixtures ai-eda-openroad-eda-corpus-convert ai-eda-tilos-macroplacement-convert ai-eda-circuitnet3-convert ai-eda-chipbench-d-convert ai-eda-aieda-idata-convert ai-eda-edalearn-convert ai-eda-macro-place-challenge-convert ai-eda-mlcad-fpga-macro-convert ai-eda-research-code-assets-convert ai-eda-current-research-watchlist-convert ai-eda-openabc-d-convert ai-eda-e1-softmacro-cases ai-eda-external-fixture-convert ai-eda-e1-openlane-convert ai-eda-openlane-flow-labels
	@$(PYTHON) scripts/ai_eda/build_training_corpus_manifest.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_training_corpus_manifest.py --manifest build/ai_eda/training_corpus_manifest/$(AI_EDA_RUN_ID)/training_corpus_manifest.json

ai-eda-openroad-ml-snapshot:
	@$(PYTHON) scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_openroad_ml_snapshot.py --report build/ai_eda/pd_predictor_dataset/$(AI_EDA_RUN_ID)/snapshot_manifest.json

ai-eda-pd-surrogate-smoke: ai-eda-openlane-flow-labels
	@$(PYTHON) scripts/ai_eda/train_pd_surrogate_smoke.py --run-id $(AI_EDA_RUN_ID)

ai-eda-fixture-placement-train: ai-eda-internal-fixtures
	@$(PYTHON) scripts/ai_eda/train_fixture_placement_smoke.py --run-id $(AI_EDA_RUN_ID) --device cpu

ai-eda-macro-placement-supervised-dataset: ai-eda-internal-fixtures ai-eda-tilos-macroplacement-convert ai-eda-chipbench-d-convert ai-eda-e1-softmacro-cases
	@$(PYTHON) scripts/ai_eda/build_macro_placement_supervised_dataset.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_macro_placement_supervised_dataset.py --report build/ai_eda/macro_placement_supervised_dataset/$(AI_EDA_RUN_ID)/macro_placement_supervised_dataset_report.json

ai-eda-macro-placement-supervised-train: ai-eda-macro-placement-supervised-dataset
	@$(PYTHON) scripts/ai_eda/train_macro_placement_supervised_model.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_macro_placement_supervised_model.py --report build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/supervised_training_run.json
	@$(PYTHON) scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates

ai-eda-macro-placement-torch-train: ai-eda-macro-placement-supervised-dataset
	@$(PYTHON) scripts/ai_eda/train_macro_placement_torch_regressor.py --run-id $(AI_EDA_RUN_ID) --device auto --epochs 25
	@$(PYTHON) scripts/ai_eda/check_macro_placement_torch_regressor.py --report build/ai_eda/macro_placement_torch_regressor/$(AI_EDA_RUN_ID)/torch_training_run.json

ai-eda-macro-placement-torch-infer: ai-eda-macro-placement-torch-train
	@$(PYTHON) scripts/ai_eda/infer_macro_placement_torch_regressor.py --run-id $(AI_EDA_RUN_ID) --device auto
	@$(PYTHON) scripts/ai_eda/check_macro_placement_torch_inference.py --report build/ai_eda/macro_placement_torch_inference/$(AI_EDA_RUN_ID)/torch_inference_run.json
	@$(PYTHON) scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_torch_inference/$(AI_EDA_RUN_ID)/candidates

ai-eda-macro-placement-supervised-replay-plan: ai-eda-macro-placement-supervised-train
	@$(PYTHON) scripts/ai_eda/plan_macro_placement_replay.py --run-id $(AI_EDA_RUN_ID) --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates --out-root build/ai_eda/macro_placement_supervised_replay
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_supervised_replay/$(AI_EDA_RUN_ID)/replay_plan.json
	@$(PYTHON) scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_supervised_replay/$(AI_EDA_RUN_ID)/tool_actions

ai-eda-macro-placement-baseline: ai-eda-internal-fixtures ai-eda-e1-openlane-convert ai-eda-tilos-macroplacement-convert ai-eda-e1-softmacro-cases
	@$(PYTHON) scripts/ai_eda/train_macro_placement_policy.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_macro_placement_baseline.py --report build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/macro_placement_baseline_report.json
	@$(PYTHON) scripts/ai_eda/check_candidate_manifests.py --candidate-dir build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/candidates

ai-eda-macro-placement-candidate-eval: ai-eda-macro-placement-baseline
	@$(PYTHON) scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id $(AI_EDA_RUN_ID)

ai-eda-macro-placement-combined-candidate-eval: ai-eda-macro-placement-baseline ai-eda-macro-placement-supervised-train
	@$(PYTHON) scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id $(AI_EDA_RUN_ID) --candidate-dir build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates --out-root build/ai_eda/macro_placement_combined_candidate_eval

ai-eda-macro-placement-full-candidate-eval: ai-eda-macro-placement-combined-candidate-eval ai-eda-macro-placement-torch-infer
	@$(PYTHON) scripts/ai_eda/evaluate_macro_placement_candidates.py --run-id $(AI_EDA_RUN_ID) --candidate-dir build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/$(AI_EDA_RUN_ID)/candidates --out-root build/ai_eda/macro_placement_full_candidate_eval

ai-eda-macro-placement-replay-plan: ai-eda-macro-placement-candidate-eval
	@$(PYTHON) scripts/ai_eda/plan_macro_placement_replay.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_replay/$(AI_EDA_RUN_ID)/replay_plan.json
	@$(PYTHON) scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_replay/$(AI_EDA_RUN_ID)/tool_actions

ai-eda-macro-placement-replay-preflight: ai-eda-macro-placement-replay-plan
	@$(PYTHON) scripts/ai_eda/replay_macro_placement_on_e1.py --run-id $(AI_EDA_RUN_ID) --plan build/ai_eda/macro_placement_replay/$(AI_EDA_RUN_ID)/replay_plan.json
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_preflight.py --report build/ai_eda/macro_placement_replay_preflight/$(AI_EDA_RUN_ID)/replay_preflight_report.json

ai-eda-macro-placement-combined-replay-plan: ai-eda-macro-placement-combined-candidate-eval
	@$(PYTHON) scripts/ai_eda/plan_macro_placement_replay.py --run-id $(AI_EDA_RUN_ID) --candidate-dir build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates --out-root build/ai_eda/macro_placement_combined_replay
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_combined_replay/$(AI_EDA_RUN_ID)/replay_plan.json
	@$(PYTHON) scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_combined_replay/$(AI_EDA_RUN_ID)/tool_actions

ai-eda-macro-placement-full-replay-plan: ai-eda-macro-placement-full-candidate-eval
	@$(PYTHON) scripts/ai_eda/plan_macro_placement_replay.py --run-id $(AI_EDA_RUN_ID) --candidate-dir build/ai_eda/macro_placement_policy/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_supervised_model/$(AI_EDA_RUN_ID)/candidates --candidate-dir build/ai_eda/macro_placement_torch_inference/$(AI_EDA_RUN_ID)/candidates --out-root build/ai_eda/macro_placement_full_replay
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_plan.py --report build/ai_eda/macro_placement_full_replay/$(AI_EDA_RUN_ID)/replay_plan.json
	@$(PYTHON) scripts/ai_eda/check_tool_action_manifests.py --manifests-dir build/ai_eda/macro_placement_full_replay/$(AI_EDA_RUN_ID)/tool_actions

ai-eda-macro-placement-replay-queue: ai-eda-macro-placement-full-replay-plan
	@$(PYTHON) scripts/ai_eda/select_macro_placement_replay_queue.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_macro_placement_replay_queue.py --report build/ai_eda/macro_placement_replay_queue/$(AI_EDA_RUN_ID)/replay_queue.json

ai-eda-candidate-manifests-check: ai-eda-fixture-placement-train
	@$(PYTHON) scripts/ai_eda/check_candidate_manifests.py

ai-eda-assertion-candidate-manifests-check:
	@$(PYTHON) scripts/ai_eda/check_assertion_candidate_manifests.py

ai-eda-tool-actions-check: ai-eda-internal-schemas-check
	@$(PYTHON) scripts/ai_eda/check_tool_action_schemas.py

ai-eda-cocotb-stimulus-dry-run:
	@$(PYTHON) scripts/ai_eda/run_cocotb_stimulus_search.py --dry-run --run-id $(AI_EDA_RUN_ID)

ai-eda-verification-targets:
	@$(PYTHON) scripts/ai_eda/capture_logic_synthesis_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_verification_target_captures.py --run-id $(AI_EDA_RUN_ID)

ai-eda-physical-design-targets:
	@$(PYTHON) scripts/ai_eda/capture_timing_closure_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_routing_congestion_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_placement_legalization_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_physical_verification_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_physical_design_target_captures.py --run-id $(AI_EDA_RUN_ID)

ai-eda-optimization-targets:
	@$(PYTHON) scripts/ai_eda/capture_current_research_watchlist.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_current_research_watchlist.py --report build/ai_eda/current_research_watchlist/$(AI_EDA_RUN_ID)/targets_report.json
	@$(PYTHON) scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_low_power_intent_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_hardware_security_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_ai_optimization_target_captures.py --run-id $(AI_EDA_RUN_ID)

ai-eda-all-target-captures:
	@$(PYTHON) scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_board_package_fpga_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_cdc_rdc_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_clock_tree_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_compiler_autotuning_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_current_research_watchlist.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_current_research_watchlist.py --report build/ai_eda/current_research_watchlist/$(AI_EDA_RUN_ID)/targets_report.json
	@$(PYTHON) scripts/ai_eda/capture_cpu_microarchitecture_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_dft_atpg_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_extraction_parasitic_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_hardware_security_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_hls_accelerator_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_ip_register_contract_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_logic_synthesis_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_low_power_intent_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_memory_interconnect_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_memory_macro_library_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_physical_verification_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_placement_legalization_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_power_thermal_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_reliability_resilience_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_routing_congestion_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_simulator_optimization_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_software_bsp_firmware_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_spec_traceability_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_timing_closure_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/capture_verification_debug_targets.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_verification_target_captures.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_physical_design_target_captures.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_ai_optimization_target_captures.py --run-id $(AI_EDA_RUN_ID)

ai-eda-logic-synthesis-recipes:
	@$(PYTHON) scripts/ai_eda/generate_logic_synthesis_recipe_corpus.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_logic_synthesis_policy_baseline.py --corpus build/ai_eda/logic_synthesis_recipes/$(AI_EDA_RUN_ID)/recipe_corpus.json --corpus-only

ai-eda-logic-synthesis-baseline: ai-eda-logic-synthesis-recipes
	@$(PYTHON) scripts/ai_eda/run_logic_synthesis_policy_baseline.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_logic_synthesis_policy_baseline.py --corpus build/ai_eda/logic_synthesis_recipes/$(AI_EDA_RUN_ID)/recipe_corpus.json --report build/ai_eda/logic_synthesis_baselines/$(AI_EDA_RUN_ID)/baseline_report.json

ai-eda-cuda-preflight:
	@$(PYTHON) scripts/ai_eda/preflight_cuda_training_stack.py --run-id $(AI_EDA_RUN_ID)

ai-eda-cuda-payload:
	@$(PYTHON) scripts/ai_eda/package_cuda_training_payload.py --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_cuda_training_payload.py --report build/ai_eda/cuda_training_payloads/$(AI_EDA_RUN_ID)/cuda_training_payload_report.json

ai-eda-cuda-payload-check:
	@$(PYTHON) scripts/ai_eda/check_cuda_training_payload.py --report build/ai_eda/cuda_training_payloads/$(AI_EDA_RUN_ID)/cuda_training_payload_report.json

ai-eda-cuda-run-plan-dry-run: ai-eda-cuda-payload
	@$(PYTHON) scripts/ai_eda/execute_cuda_run_plan.py --plan build/ai_eda/cuda_training_payloads/$(AI_EDA_RUN_ID)/cuda_training_run_plan.json --run-id $(AI_EDA_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_cuda_run_plan_execution.py --report build/ai_eda/cuda_run_plan_execution/$(AI_EDA_RUN_ID)/cuda_run_plan_execution.json

ai-eda-cuda-run-plan-safety-matrix: ai-eda-cuda-payload
	@$(PYTHON) scripts/ai_eda/check_cuda_run_plan_safety_matrix.py --plan build/ai_eda/cuda_training_payloads/$(AI_EDA_RUN_ID)/cuda_training_run_plan.json --run-id $(AI_EDA_RUN_ID)

ai-eda-cuda-readiness-audit: ai-eda-cuda-preflight ai-eda-cuda-run-plan-dry-run ai-eda-cuda-run-plan-safety-matrix ai-eda-alphachip-checkpoint-blocker-check ai-eda-optimization-targets ai-eda-macro-placement-replay-preflight
	@$(PYTHON) scripts/ai_eda/capture_cuda_readiness_audit.py --run-id $(AI_EDA_RUN_ID) --setup-run-id $(AI_EDA_SETUP_RUN_ID) --training-handoff-run-id $(AI_EDA_TRAINING_HANDOFF_RUN_ID)
	@$(PYTHON) scripts/ai_eda/check_cuda_readiness_audit.py --report build/ai_eda/cuda_readiness_audit/$(AI_EDA_RUN_ID)/cuda_readiness_audit.json

docs-check: ai-eda-local-rag-index ai-eda-backend-preflight ai-eda-all-target-captures ai-eda-source-inventory-check ai-eda-ai-workload-manifest-check ai-eda-assertion-candidate-manifests-check ai-eda-external-assets-check ai-eda-external-intake-check ai-eda-alphachip-checkpoint-blocker-check ai-eda-external-method-wrapper-readiness-check ai-eda-internal-schemas-check ai-eda-candidate-manifests-check ai-eda-tool-actions-check ai-eda-cocotb-stimulus-dry-run
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

# ---------------------------------------------------------------------------
# Compiler / toolchain / NPU codegen targets
# Owned by docs/architecture-optimization/sota-2028/compiler-tuning.md.
# Every target fails closed when the canonical Linux container build is
# missing per docs/toolchain/llvm-trunk-pin.md.
# ---------------------------------------------------------------------------
.PHONY: llvm-build iree-build executorch-tests quantize-tests autovec-bench autofdo-capture propeller-relink bolt-optimize quantize-models rva23-compliance baseline-profile-capture compiler-versions compiler-tests

llvm-build:
	@scripts/build_llvm_riscv.sh

iree-build:
	@scripts/build_iree_eliza_npu.sh

autovec-bench:
	@$(BENCH_PYTHON) scripts/run_rvv_autovec_suite.py

autofdo-capture:
	@scripts/run_autofdo_capture.sh

propeller-relink:
	@if [ -z "$(SYMBOL_ORDER)" ] || [ -z "$(INPUTS)" ] || [ -z "$(OUTPUT)" ]; then \
		echo "usage: make propeller-relink INPUTS='a.o b.o ...' SYMBOL_ORDER=order.txt OUTPUT=elf"; \
		echo "STATUS: BLOCKED propeller.usage"; \
		exit 2; \
	fi
	@compiler/propeller-harness/relink.sh --inputs $(INPUTS) --symbol-order $(SYMBOL_ORDER) --output $(OUTPUT)

bolt-optimize:
	@if [ -z "$(BINARY)" ] || [ -z "$(OUTPUT)" ]; then \
		echo "usage: make bolt-optimize BINARY=in WORKLOAD=run.sh OUTPUT=out"; \
		echo "STATUS: BLOCKED bolt.usage"; \
		exit 2; \
	fi
	@compiler/bolt-harness/optimize.sh --binary $(BINARY) --workload $(WORKLOAD) --output $(OUTPUT)

quantize-models: quantize-tests
	@echo "STATUS: BLOCKED quantize.real_models -- requires torch + executorch in container"

quantize-tests:
	@$(BENCH_PYTHON) -m pytest compiler/quantization/tests/ -q

executorch-tests:
	@$(BENCH_PYTHON) -m pytest compiler/executorch-eliza/tests/ -q

rva23-compliance:
	@$(PYTHON) scripts/check_rva23_compliance.py

baseline-profile-capture:
	@if [ -z "$(APP)" ] || [ -z "$(OUTPUT)" ]; then \
		echo "usage: make baseline-profile-capture APP=apps/demo OUTPUT=build/reports/compiler/baseline-prof.txt"; \
		echo "STATUS: BLOCKED baseline.usage"; \
		exit 2; \
	fi
	@compiler/baseline-profiles/capture.sh --app $(APP) --output $(OUTPUT)

compiler-versions:
	@$(PYTHON) scripts/check_compiler_versions.py

compiler-tests: quantize-tests executorch-tests
	@$(BENCH_PYTHON) -m pytest compiler/iree-eliza-npu/tests/test_descriptor_parity.py -q

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
