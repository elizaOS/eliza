# AI/EDA SOTA Review For E1 Integration

This is a working review of AI-assisted chip-design automation relevant to the
E1 scaffold. It is intentionally conservative: AI outputs are not evidence, and
every recommendation below requires local deterministic gates before it can
affect source, release claims, or tapeout-facing artifacts.

## Critical Takeaways

- Agentic EDA is useful now for orchestration, log triage, script drafting, and
  design-space bookkeeping, but autonomous signoff is not credible for this
  package. The E1 flow should expose narrow, typed actions with archived inputs,
  outputs, and checker results.
- RTL generation has the most visible open model and benchmark activity
  (RTL-Coder, VerilogEval, CVDP, ChipCraftX RTLGen, RTLRepoCoder), but generated
  RTL is production-risky unless isolated as an artifact and promoted only after
  lint, simulation, synthesis, equivalence where relevant, and human review.
- Physical-design ML is high-value for pruning and prioritization. CircuitNet,
  RouteGNN/RoutePlacer, AlphaChip/Circuit Training, TILOS MacroPlacement,
  DREAMPlace, and AutoDMP are relevant, but E1 needs local labels from completed
  OpenLane/OpenROAD runs before predictor output can guide engineering.
- Circuit foundation models are the infrastructure layer beneath many future
  agents and predictors. ChipNeMo and ChipLingo show domain-adapted EDA LLM
  patterns, while GenEDA, NetTAG, and DeepGate4 represent netlist, graph, text,
  RTL, and layout alignment. For E1, this is corpus-governance and target
  capture only until local artifacts, licenses, held-out tasks, and downstream
  deterministic gates exist.
- Verification is the safest near-term automation lane: agents can propose
  cocotb stimulus for named coverage bins, while acceptance remains entirely
  deterministic through existing regressions.
- Assertion generation is promising but higher risk than stimulus generation:
  AssertLLM, AssertionForge, and CodeV-SVA can propose SVAs, but E1 should keep
  them in candidate manifests until signal mapping, formal/simulation, and human
  review pass.
- Verification planning and formal-debug agents are a separate loop from
  ordinary stimulus generation. PRO-V shows open agentic RTL verification code,
  Saarthi frames end-to-end formal-verification agents, SANGAM uses
  self-refining assertion search, FVDebug targets formal counterexample
  root-cause analysis, and SiliconMind-V1 provides open Verilog debug models.
  E1 should use them only as dry-run target capture until local traces,
  deterministic regressions, equivalence/synthesis when needed, and reviewer
  disposition exist.
- Simulator and NPU architecture search should start with manifest-backed
  design-space exploration. ZigZag, Timeloop/Accelergy, DOSA, and newer
  generative DSE work such as DiffAxE can prioritize experiments, but product
  claims require runtime-contract, roadmap, benchmark, synthesis, and simulator
  evidence.
- Memory, interconnect, NoC, and accelerator-system simulation are strong
  candidates for AI-guided design-space exploration, but only after the E1
  memory/fabric contracts define valid knobs. ArchGym, BookSim2, Ramulator2,
  DRAMsim3, DRAMSys, gem5-Aladdin, and Gem5-AcceSys are useful references; the
  current E1 AXI-Lite SRAM-backed scaffold makes them target-capture only.
- CPU microarchitecture search is now an explicit AI lane. Agentic Architect
  extends the agentic-EDA idea into branch predictors, cache replacement, and
  prefetching; PerfVec and Concorde show fast CPU performance modeling; and
  BranchNet, Pythia, Mockingjay, Drishti, LLBP, and ChampSim are useful SOTA
  references. E1 should keep this behind trace provenance, simulator logs,
  before/after RTL, cocotb/formal/synthesis, and benchmark gates.
- DFT, power/thermal, and hardware-security AI are not optional for a complete
  chip-design automation map, but they are less ready for E1 source integration:
  open DFT tooling and AI ATPG methods need a scan/ATPG evidence contract,
  thermal, IR-drop, PDN, and PPA predictors need calibrated local labels, and
  Trojan-detection models remain advisory.
- Board, package, manufacturing, and FPGA automation is high-risk because
  correctness spans electrical constraints, fabrication outputs, regulatory
  evidence, and hardware bring-up. PCB schematic/placement/routing agents,
  autorouters, FPGA placers, and inspection datasets are target-capture sources
  only until E1 has release-clean package, KiCad, SI/PI, RF, manufacturing, and
  FPGA evidence.
- DFM, yield, lithography, OPC, and wafer-defect AI are important but sit
  beyond ordinary PD prediction. Hotspot detectors, differentiable lithography,
  ILT/OPC optimizers, and wafer-map classifiers need foundry decks, process
  windows, mask rules, final layout, local labels, and manufacturing evidence;
  otherwise they are research context and target capture only.
- Post-silicon validation and lab-debug automation must stay explicit rather
  than being folded into simulator success. RISC-V architectural tests, RISCOF,
  riscv-dv, QED-style methods, SoC trace-debug reconstruction, cross-target
  on-device tests, and ML/XAI boot-failure classification are useful only after
  E1 has pinned suites, target identities, logs, signatures, traces, board/FPGA
  revisions, and real-world evidence.
- Low-power intent automation needs its own evidence boundary. Clock-gating and
  low-power RTL optimization can save power, but UPF/power domains, retention,
  isolation, level shifting, DVFS, and idle states change the legal behavior of
  the SoC. E1 should not generate or apply power intent until platform, reset,
  firmware, scan, CDC/RDC, timing, power, and physical-design gates exist.

## Source Map

| Area | SOTA / useful sources | E1 action |
| --- | --- | --- |
| Agentic EDA orchestration | Agentic EDA survey, AutoEDA, ChatEDA | Keep read-only RAG and dry-run runners first; require command manifests before write-capable agents. |
| RTL generation | RTL-Coder, ChipCraftX RTLGen 7B, OpenLLM-RTL, VerilogEval, CVDP | Evaluate against small E1-style tasks; generated RTL stays in `build/ai_eda/`. |
| Repo-aware RTL assistance | RTLRepoCoder, ORAssistant-style retrieval | Build citation-required local RAG over E1 sources before any completion workflow. |
| RTL optimization and equivalence | SymRTLO, RTLRewriter-Bench, FormalRTL, timing logic metamorphosis, OpenABC-D, RocketPPA | Capture equivalence and before/after PPA target tasks only; block generated rewrites, equivalence claims, and PPA claims until local lint, simulation, formal/SAT equivalence, synthesis, OpenLane, and review evidence exist. |
| Circuit foundation models and embeddings | Circuit foundation model survey, ChipNeMo, GenEDA, NetTAG, DeepGate4, ChipLingo | Capture corpus governance, multimodal embedding, netlist-function reasoning, and domain-adapted EDA LLM targets only; block training, embeddings, inference, corpus export, model-quality claims, and design decisions until local provenance, held-out tasks, deterministic gates, and review exist. |
| Physical design prediction | CircuitNet, CircuitNet 2.0, RoutePlacer | Capture local E1 PD feature/label manifests; predictors remain advisory. |
| Placement optimization | AlphaChip/Circuit Training, TILOS MacroPlacement, AutoDMP, DREAMPlace | Use as experiment references; compare only after routed OpenLane evidence. |
| Verification stimulus | LLM4DV, CVDP-style agent tasks, local cocotb coverage bins | Generate candidate ideas only; accept by `make cocotb-npu` and `make cocotb-contract`. |
| Assertion generation | AssertLLM, AssertionForge, CodeV-SVA | Keep proposed SVAs as reviewed candidates; require formal/simulation evidence before binding. |
| Verification planning and formal debug | PRO-V, Saarthi, SANGAM, FVDebug, SiliconMind-V1 | Capture spec-to-plan, formal counterexample triage, testbench/oracle candidates, assertion self-refinement, and patch quarantine targets; no generated patch, testbench, assertion, root-cause claim, or closure claim without local gates and review. |
| Simulator/NPU DSE | ZigZag, Timeloop/Accelergy, DOSA, DiffAxE | Use hashed architecture manifests; block claims until calibrated measurements exist. |
| Simulator/benchmark targets | ZigZag, Timeloop/Accelergy, DOSA, RTLMUL | Capture local benchmark/runtime targets; block performance claims until logs exist. |
| Software BSP, firmware, and boot simulation | LLM firmware validation, EoK RISC-V kernel optimization, IntrinTrans RVV, OpenSBI, U-Boot, MCP4EDA | Capture boot/BSP/firmware target tasks only; block generated patches, device-tree edits, boot claims, BSP claims, and kernel-performance claims until build logs, QEMU/Renode transcripts, static analysis, and review exist. |
| RTL PPA advisory | RTLMUL, VerilogEval, CVDP | Capture local RTL and synthesis hashes only; do not load weights or emit PPA predictions without revision pinning, license review, and held-out E1 error analysis. |
| HLS and accelerator DSE | HLSFactory, HLS-Eval, iDSE, SECDA-DSE | Capture E1 HLS candidate tasks from runtime/spec inputs; block generated HLS/RTL until C-sim, HLS synthesis, RTL simulation, synthesis, and review pass. |
| Timing closure and ECO | TimingPredict, E2ESlack, TimingLLM, FluxEDA, OpenROAD Resizer, IR-aware ECO RL | Capture SDC, metrics, STA, and resizer logs for advisory timing triage; block constraint/ECO edits until before/after OpenSTA/OpenLane and signoff gates pass. |
| CDC/RDC and reset-domain signoff | Accellera CDC/RDC standard, formal CDC MSI methodology, Questa CDC/RDC Assist, OpenCDC, MCP4EDA | Capture clock/reset-domain target tasks only; block generated constraints, waivers, classifications, and signoff claims until local intent, deterministic CDC/RDC reports, reset-domain regressions, and review exist. |
| Analog and mixed-signal | ALIGN, AutoCkt, GENIE-ASI, ACDC, ADO-LLM, AnalogGenie, Masala-CHAI, LIMCA | Capture padframe/package/SI-PI/IO targets only; block generated SPICE, analog layout, foundry IP, and analog IMC claims until SPICE, DRC/LVS, extraction, package, and human review evidence exists. |
| Memory, interconnect, and NoC DSE | ArchGym, AI NoC DSE, BookSim2, Ramulator2, DRAMsim3, DRAMSys, gem5-Aladdin, Gem5-AcceSys | Capture E1 memory/fabric target tasks and backend availability; block fabric, memory-map, coherency, QoS, and DRAM claims until local contract, simulator, benchmark, and RTL evidence exists. |
| CPU microarchitecture AI | Agentic Architect, PerfVec, Concorde, ChampSim, BranchNet, LLBP, Pythia, Mockingjay, Drishti | Capture branch predictor, cache replacement, prefetcher, CPU performance-model, and simulator-backed DSE targets only; block generated RTL, simulator/model execution, trace import, IPC/MPKI/area/power/product claims, and release use until local traces, before/after simulator logs, RTL/cocotb/formal/synthesis, benchmark evidence, and review exist. |
| DFT, ATPG, and manufacturing test | Fault DFT, DeepTPI, DEFT, LITE scan instrumentation, DRL ATPG, ATPG via AI survey, ATPG Toolkit, NN-for-ATPG | Capture DFT/ATPG target tasks only; block scan insertion, test-point insertion, generated patterns, and fault-coverage claims until netlist, scan policy, ATPG, manufacturing, and signoff evidence exists. |
| Power, thermal, IR drop, and PDN | DeepOHeat, 2D-ThermAl, ThermEDGe/IREDGe, WACA-UNet, IR-Drop-Predictor, EDA IR-Drop Prediction, OpeNPDN, AiEDA, RTLMUL | Capture power/thermal/PDN target tasks only; block generated power maps, thermal maps, PDNs, IR-drop predictions, TOPS/W, and thermal claims until measured traces, package models, PDNSim/OpenROAD labels, and signoff evidence exist. |
| Hardware security | Hardware Trojan ML, PEARL, TrojanSAINT, GNN-MFF, SecureRAG-RTL, TrojanWhisper, TrojanGYM, GHOST Benchmarks | Capture local RTL/security target tasks only; block scanner execution, Trojan insertion, vulnerability claims, generated-RTL trust claims, and release use until labels, deterministic regressions, provenance, and human security review exist. |
| Board, package, manufacturing, and FPGA | PCBSchemaGen, PCB-Bench, PCBAgent, NeurPCB, PCB-Migrator, PCB-PR-App, Freerouting, DREAMPlaceFPGA, RapidWright FPGA interchange, DeepPCB defect dataset | Capture local package, KiCad, FPGA, Wi-Fi/RF, and manufacturing target tasks only; block generated schematics, board placement/routing, Gerbers, package/pinout edits, FPGA output, fabrication claims, inspection claims, and release use until deterministic gates and review evidence exist. |
| DFM, yield, lithography, and OPC | Litho-aware ML hotspot detection, DLHSD, LithoHoD, TorchLitho, OpenILT, DiffOPC, RadAI WM-811K wafer defect model, Pegasus LPA | Capture hotspot-screening, differentiable lithography, ILT/OPC, signoff-feature, and wafer-defect targets only; block layout/mask/OPC edits, lithography simulation, model execution, DFM/yield/mask/wafer-defect claims, and release use until foundry/process collateral, local layout labels, deterministic signoff gates, and review exist. |
| Post-silicon validation and bring-up | Symbolic QED, SoC trace protocol debug, RISC-V DV, RISCOF, RISC-V architectural tests, OpenTitan chip tests, ML/XAI boot-failure debug, LLM4SecHW | Capture post-silicon, FPGA, RISC-V compliance, trace-debug, and lab-evidence targets only; block generated lab scripts, test binaries, hardware runs, compliance claims, silicon bring-up claims, and release use until local logs, traces, signatures, board/silicon IDs, and review exist. |
| Low-power intent, DVFS, and clock gating | IEEE 1801 UPF, IEEE UPF examples, Yosys `clockgate`, CODMAS/RTLOPT, Prompting for Power, POET, RTL PPA SOG estimation, OpenROAD two-phase clocking conversion | Capture power-state, UPF, clock-gating, DVFS, retention, isolation, and low-power verification targets only; block generated UPF, RTL edits, gated clocks, DVFS policy, retention/isolation insertion, power-saving claims, and release use until platform, RTL, formal, synthesis, DFT, CDC/RDC, power/thermal, and PD gates exist. |

## Recommended Integration Order

1. Keep expanding the checked source inventory and backlog as new sources are
   found.
2. Use `scripts/ai_eda/build_local_eda_rag_index.py` for read-only local source
   citation and log triage.
3. Use `scripts/ai_eda/run_cocotb_stimulus_search.py --dry-run` to maintain
   explicit NPU coverage bins and seed manifests.
4. Use `scripts/ai_eda/capture_openroad_ml_snapshot.py` after each OpenLane run
   to build local PD predictor labels.
5. Use `scripts/ai_eda/evaluate_rtl_model.py --dry-run` until model licenses,
   backends, and artifact isolation are resolved.
6. Defer RTL rewrite and write-capable EDA agents until equivalence and command
   authorization gates are present.
7. Track provenance in
   `research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml`
   before importing external code, model weights, or datasets.
8. Regenerate
   `build/ai_eda/external_source_probe/validation/source_probe_report.json`
   when the source inventory changes so GitHub/Hugging Face availability and
   license hints are visible, while still blocked from release use.
   The checked summary
   `research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml`
   records current high-priority follow-ups such as the noncommercial
   ChipCraftX RTLGen license and ambiguous assertion-framework licenses.
9. Regenerate
   `build/ai_eda/backend_preflight/validation/backend_preflight_report.json`
   to distinguish locally runnable backends from merely reachable external
   projects. A present backend is still not release evidence.
10. Use `scripts/ai_eda/run_rtlmul_ppa_advisory.py --run-id validation` only
    for RTLMUL target capture. It records local RTL/Yosys context while keeping
    model weights unloaded and predictions unavailable until license review,
    pinned revisions, and held-out E1 error analysis exist.
11. Use `scripts/ai_eda/capture_hls_accelerator_targets.py --run-id validation`
    to keep HLS/accelerator automation anchored to local E1 runtime and spec
    artifacts before any HLS generator or directive-search loop is enabled.
12. Use `scripts/ai_eda/capture_timing_closure_targets.py --run-id validation`
    to capture timing-closure inputs and OpenLane STA/resizer evidence before
    any AI-assisted constraint review or ECO-search loop is allowed to write.
13. Use
    `scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation`
    to keep analog/AMS automation tied to local padframe, package, Wi-Fi IO,
    SI/PI, and process blockers before any SPICE/layout/IP generator is allowed.
14. Use
    `scripts/ai_eda/capture_memory_interconnect_targets.py --run-id validation`
    to keep architecture DSE, NoC, DRAM, and accelerator-system simulator
    sources tied to local memory/interconnect contracts before any fabric,
    coherency, QoS, memory-map, or simulator-backed optimization loop is
    allowed to write.
15. Use `scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation` to
    keep DFT, ATPG, scan, and testability AI sources tied to local RTL,
    constraints, manufacturing, and signoff blockers before any scan insertion,
    test-point insertion, ATPG execution, or generated pattern flow is allowed.
16. Use `scripts/ai_eda/capture_power_thermal_targets.py --run-id validation`
    to keep thermal surrogates, IR-drop predictors, PDN synthesis methods, and
    RTL power priors tied to sustained measurement, package, PD signoff, and
    benchmark blockers before any generated map, PDN edit, TOPS/W, or thermal
    claim is allowed.
17. Use `scripts/ai_eda/capture_hardware_security_targets.py --run-id validation`
    to keep hardware-security, Trojan-detection, RAG triage, and adversarial
    benchmark sources tied to local RTL hashes, formal/simulation gates,
    no-hardware-action policy, and security review before any scanner output,
    Trojan insertion, generated-RTL trust claim, or vulnerability claim is
    allowed.
18. Use `scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation`
    to keep CDC/RDC standards, formal metastability methodology, ML-assisted
    CDC/RDC setup, and open analyzer candidates tied to local clock/reset RTL,
    SDC, formal, reset-domain regressions, and waiver blockers before any
    generated constraint, waiver, classification, or signoff claim is allowed.
19. Use `scripts/ai_eda/capture_software_bsp_firmware_targets.py --run-id validation`
    to keep AI firmware validation, RISC-V kernel optimization, OpenSBI,
    U-Boot, Linux BSP, QEMU, and Renode work tied to local boot ROM, DTS,
    driver, simulator, and transcript blockers before any generated patch,
    boot claim, BSP claim, or software performance claim is allowed.
20. Use `scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation`
    to keep LLM RTL rewrite, symbolic optimization, formal RTL synthesis,
    timing-logic metamorphosis, synthesis datasets, and PPA predictors tied to
    local RTL, formal, cocotb, synthesis, and OpenLane blockers before any
    generated rewrite, equivalence claim, or PPA improvement claim is allowed.
21. Use `scripts/ai_eda/capture_board_package_fpga_targets.py --run-id validation`
    to keep PCB schematic, KiCad placement/routing, PCB migration, autorouting,
    FPGA placement/interchange, and PCB inspection sources tied to local
    package, board, Wi-Fi/RF, manufacturing, real-world, and FPGA blockers
    before any generated board, package, pinout, Gerber, FPGA, fabrication, or
    release claim is allowed.
22. Use `scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation`
    to keep IEEE 1801/UPF, low-power RTL generation, LLM clock-gating, Yosys
    clock-gating, power-first RTL optimization, DVFS/idle-state, retention, and
    isolation sources tied to local platform, RTL, formal, synthesis, DFT,
    CDC/RDC, software/BSP, power/thermal, and PD blockers before any generated
    UPF, gated clock, DVFS policy, power-domain artifact, or power-saving claim
    is allowed.
23. Use `scripts/ai_eda/capture_verification_debug_targets.py --run-id validation`
    to keep PRO-V, Saarthi, SANGAM, FVDebug, and SiliconMind-V1 tied to local
    RTL, formal, cocotb, assertion, and spec hashes before any AI-generated
    verification plan, testbench, assertion, root-cause report, RTL patch, or
    verification-closure claim is allowed.
24. Use `scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id validation`
    to keep RISC-V compliance, random-instruction validation, QED/trace-debug
    methods, cross-target on-device tests, boot-failure triage, FPGA bring-up,
    and lab automation tied to local QEMU/Renode, FPGA, package/board,
    manufacturing, real-world, benchmark, and release gates before any
    generated lab script, test binary, hardware action, compliance claim, or
    silicon bring-up claim is allowed.
25. Use `scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id validation`
    to keep circuit foundation models, graph/text/layout embeddings,
    domain-adapted EDA LLMs, and netlist-function reasoning tied to local
    source provenance, RAG, RTL, spec, PD, formal, synthesis, and verification
    gates before any corpus export, training, embedding generation, inference,
    model-quality claim, or design-decision claim is allowed.
26. Use `scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id validation`
    to keep DFM/yield, lithography hotspot detection, differentiable
    lithography, ILT/OPC, wafer-defect classification, and commercial-signoff
    comparisons tied to local PD, manufacturing, real-world, synthesis, and
    review gates before any layout, mask, OPC, hotspot, yield, wafer-defect, or
    release claim is allowed.
27. Use `scripts/ai_eda/capture_cpu_microarchitecture_targets.py --run-id validation`
    to keep branch predictor, cache replacement, prefetcher, CPU performance
    model, and simulator-backed microarchitecture DSE work tied to local BPU,
    cache, benchmark, simulator, RTL, synthesis, formal, cocotb, and review
    gates before any generated RTL, policy change, IPC/MPKI claim, or product
    performance claim is allowed.

## Current Blockers

- Local RTL checking is blocked until Verilator or Icarus Verilog is available.
- OpenLane evidence is blocked while the current run is incomplete or locked.
- No AI-generated RTL, stimulus, placement, or predictor output has been
  accepted into source.
- License review is still required for external code, datasets, and model
  weights.
