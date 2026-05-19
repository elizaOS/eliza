SHELL := /bin/sh

PYTHON ?= python3
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

.PHONY: venv tools lint lint-fix typecheck analysis verify-all smoke ci-fast ci-local ci-strict ci-pd benchmarks-dry-run benchmarks benchmark-tools benchmarks-local-host-evidence benchmark-modeled-artifacts benchmark-modeled-cpu-npu cpu-npu-modeled-benchmark-eval cpu-npu-burst-sustained-policy cpu-npu-burst-thermal-transient cpu-npu-aosp-governor-trace cpu-npu-14a-process-eval cpu-npu-competitive-envelope cpu-npu-tapeout-readiness-audit cpu-npu-tapeout-readiness-audit-test cpu-npu-design-space-frontier benchmark-sim-metrics benchmark-cpu-ap-sim-metrics benchmark-cpu-ap-sota-sim-metrics benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test soc-thermal-sweep soc-thermal-sweep-test soc-optimization soc-optimization-work-order soc-optimization-test cpu-npu-2028-readiness-scorecard cpu-npu-2028-readiness-scorecard-test cpu-npu-manual-review cpu-npu-manual-review-test power-thermal-evidence-check power-thermal-evidence-test process-14a-effects-check process-14a-effects-test e1-npu-nnapi-proof-check mvp-status mvp-status-strict mvp-status-json mvp-simulator mvp-simulator-check mvp-simulator-status-test aosp-simulator-completion-check android-sim-peripheral-evidence linux-handoff-check chipyard-generator-check chipyard-generated-check chipyard-generated-linux-contract-check chipyard-verilator-linux-smoke-check cpu-ap-scaffold-check cpu-ap-capture-plan cpu-ap-capture-preflight cpu-ap-capture-wire cpu-ap-capture-wire-preflight cpu-ap-evidence-check cpu-ap-evidence-test cpu-ap-completion-gate no-hardware-action-check memory-uma-claim-gate memory-evidence-template-check memory-interconnect-contract-check memory-axi4-check iommu-evidence-check cocotb-axi4 cocotb-iommu stream-bench lmbench-bw mlc-bench dma-buf-negative dramsim-sweep npu-2028-target-check npu-runtime-contract-check npu-roadmap-check npu-open-scale-model-check npu-scale-sim-check scale-feasibility-gate verification-maturity-matrix-check project-plan-check prototype-status-dashboard-check phone-soc-claim-check product-feature-gates-check product-check product-release-check product-evidence-commands product-resolved-manifest pinout-check fpga-check fpga-release-check wifi-interface-check padframe-check board-package-evidence-check package-cross-probe-check kicad-artifact-check openlane-run-preflight-check physical-closure-work-order-check manufacturing-artifacts-check manufacturing-artifacts-release-check kicad-artifacts-check package-artifacts-check fpga-artifacts-check real-world-gates-check antenna-metadata-check antenna-metadata-release-check pd-preflight-check pd-contract-check pd-signoff-manifest-check bootrom-check rtl-check stub-audit cocotb cocotb-npu cocotb-contract cocotb-cpu verilator formal synth openlane openlane-smoke openroad qemu renode qemu-check qemu-check-strict qemu-os-check qemu-status-test renode-check renode-check-strict renode-status-test android-sim-boot-check android-sim-status-test aosp-linux-preflight aosp-linux-handoff aosp-linux-handoff-build-only platform-contract-check software-contract-check buildroot-check buildroot-scaffold-check buildroot-import-check linux-bsp-check linux-scaffold-check linux-import-check aosp-bsp-check aosp-scaffold-check aosp-import-check aosp-build-preflight aosp-build-riscv64 bsp-scaffold-check software-bsp-check software-bsp-scaffold-check software-bsp-external-preflight software-bsp-evidence-check software-bsp-test docs-check tool-versions record-tool-versions pipeline-check archive-check archive-release clean

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

cpu-npu-tapeout-readiness-audit: cpu-npu-competitive-envelope benchmarks-dry-run
	@$(PYTHON) scripts/check_cpu_npu_tapeout_readiness_audit.py

cpu-npu-tapeout-readiness-audit-test:
	@$(PYTHON) scripts/test_cpu_npu_tapeout_readiness_audit.py

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

.PHONY: core-selection-check core-selection-check-strict xiangshan-generator-check cva6-generator-check boom-generator-check ascalon-license-check linux-smoke linux-boot-check linux-boot-check-strict coremark embench jetstream spec-skeleton cocotb-cpu-extended pmu-event-alignment-check cpu-lint-check

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
	@$(PYTHON) scripts/write_axi4_cocotb_status.py

iommu-evidence-check:
	@$(PYTHON) scripts/check_iommu_evidence.py

cocotb-axi4:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_axi4_burst \
	  COCOTB_TOPLEVEL=e1_axi4_tb COCOTB_DIR=verify/cocotb/axi4 \
	  scripts/run_cocotb.sh

cocotb-iommu:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_riscv_iommu \
	  COCOTB_TOPLEVEL=e1_iommu_tb COCOTB_DIR=verify/cocotb/iommu \
	  scripts/run_cocotb.sh

.PHONY: cocotb-soc-boot-smoke cocotb-cross-domain soc-integration-check

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

soc-integration-check: cocotb-soc-boot-smoke cocotb-cross-domain
	@$(PYTHON) scripts/check_soc_integration.py

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

security-2028-target-check:
	@$(PYTHON) scripts/check_security_2028_target.py

pd-util-check:
	@$(PYTHON) scripts/check_pd_utilization.py

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

rtl-check:
	@scripts/run_rtl_check.sh

stub-audit:
	@$(PYTHON) verify/check_stub_audit.py

cocotb:
	@PYTHON=$(COCOTB_PYTHON) scripts/run_cocotb.sh

cocotb-npu:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_MODULE=test_e1_npu COCOTB_TOPLEVEL=e1_npu scripts/run_cocotb.sh

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
	cocotb-cache-mockingjay cocotb-cache-coherence-vectors \
	formal-cache champsim-prefetch-sweep mockingjay-vs-lru-sweep \
	lmbench-cache-curve stream-cache-bench pointer-chase-cache-bench

cache-hierarchy-claim-gate:
	@$(PYTHON) scripts/check_cache_hierarchy.py

cocotb-cache: cocotb-cache-l1d cocotb-cache-l1i cocotb-cache-drrip \
	cocotb-cache-stride cocotb-cache-bdi cocotb-cache-bdi-roundtrip \
	cocotb-cache-berti cocotb-cache-ipcp cocotb-cache-spp \
	cocotb-cache-best-offset cocotb-cache-fdip cocotb-cache-hawkeye \
	cocotb-cache-mockingjay cocotb-cache-coherence-vectors

cocotb-cache-coherence: cocotb-cache-coherence-vectors

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

cocotb-cache-coherence-vectors:
	@PYTHON=$(COCOTB_PYTHON) COCOTB_DIR=verify/cocotb/cache \
	  COCOTB_MODULE=test_coherence_vectors COCOTB_TOPLEVEL=e1_l1d_cache \
	  scripts/run_cocotb_cache.sh

formal-cache:
	@scripts/run_formal_cache.sh

champsim-prefetch-sweep:
	@$(PYTHON) scripts/champsim_sweep.py --mode prefetch || \
	  ($(PYTHON) scripts/champsim_sweep.py --mode prefetch --blocked-evidence)

mockingjay-vs-lru-sweep:
	@$(PYTHON) scripts/champsim_sweep.py --mode mockingjay-vs-lru || \
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

software-bsp-external-preflight:
	@$(PYTHON) scripts/check_software_bsp.py external-preflight all --write-report

software-bsp-evidence-check:
	@$(PYTHON) scripts/check_software_bsp.py all --require-evidence

software-bsp-test:
	@$(PYTHON) scripts/test_software_bsp_checks.py
	@$(PYTHON) scripts/test_software_bsp_evidence.py

evidence-regression-test: no-hardware-action-check software-bsp-test physical-gates-test product-feature-gates-check benchmark-sim-metrics-test benchmark-calibration-test benchmark-parser-test renode-status-test cocotb cocotb-npu cocotb-contract cocotb-cpu record-tool-versions strict-release-gate-test
	@echo "evidence regression tests complete"

.PHONY: ai-eda-source-inventory-check
ai-eda-source-inventory-check:
	@$(PYTHON) scripts/check_ai_eda_source_inventory.py

docs-check: ai-eda-source-inventory-check
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
