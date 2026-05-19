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
  (RTL-Coder, CodeV-R1, EvolVE, VeriAgent, VerilogEval, CVDP, ChipCraftX
  RTLGen, RTLRepoCoder), but generated RTL is production-risky unless isolated
  as an artifact and promoted only after lint, simulation, synthesis,
  equivalence where relevant, and human review.
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
- Compiler and code-generation automation is a separate evidence surface from
  BSP work. LLVM MLGO, TVM MetaSchedule/Ansor, AutoFDO/Propeller/BOLT,
  IntrinTrans/VecIntrinBench/SimdBench, and agentic compiler optimization can
  improve shipped binaries or RVV/NPU kernels, but E1 needs pinned toolchains,
  source/binary/profile hashes, semantic tests, simulator/runtime logs,
  calibrated benchmarks, and review before generated code or profiles are used.
- External model and corpus intake is now a first-class gate because current
  HuggingFace and GitHub assets include RTL models, Verilog corpora,
  metric-reasoning datasets, CircuitNet-style multimodal corpora, SVA data, and
  wafer-defect weights. None should be downloaded, trained, inferred, or used
  for claims until revisions, licenses, manifests, contamination checks,
  quarantine paths, deterministic gates, and reviewer dispositions exist.
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
- Reliability and resilience automation is a separate target, not a generic
  verification or power add-on. Aging, electromigration, soft-error, fault
  injection, and ECC/TMR/replay choices need process-qualified models, activity
  and mission profiles, fault manifests, simulator or formal logs, before/after
  PPA, and signoff review before any mitigation or reliability claim is usable.

## Source Map

| Area | SOTA / useful sources | E1 action |
| --- | --- | --- |
| Agentic EDA orchestration | Agentic EDA survey, AutoEDA, ChatEDA, LLM-powered EDA log analysis, MCP4EDA, Synopsys.ai Copilot, Cadence JedAI, Cadence ChipStack AI Super Agent, Siemens Fuse EDA AI Agent, Phoenix-bench | Keep read-only RAG and dry-run runners first; require typed command schemas, explicit scopes, commercial license review, archived log/schema hashes, output hashes, deterministic replay, and reviewer disposition before write-capable agents or generated fixes. |
| RTL generation | RTL-Coder, ChipCraftX RTLGen 7B, ChipSeek, RTLSeek, CodeV-R1, EvolVE, VeriAgent, OpenLLM-RTL, VerilogEval, CVDP | Evaluate against small E1-style tasks; block generated RTL, RL training, evolutionary search, evolving-memory loops, inference, and PPA claims until lint, simulation, synthesis, formal where applicable, contamination checks, and review pass. |
| External models and corpora | OpenRTLSet, MG-Verilog, DeepCircuitX, MetRex, CircuitNet 3.0, VeriForge, LLM-EDA OpenCores, Hardware VerilogEval v2, LLM_4_Verilog, SiliconMind-V1, ChipCraftX, ChipSeek, RTLSeek, CodeV-R1, EvolVE, VeriAgent, SafeTune, TrojanLoC, CodeV-SVA, RadAI WM-811K | Capture HuggingFace/GitHub model and corpus intake targets only; block downloads, imports, training, fine-tuning, inference, evaluation, generated source, and release use until exact revisions, licenses, manifests, poisoning and contamination checks, quarantine paths, deterministic local gates, and review exist. |
| Benchmark contamination and evaluation hygiene | VeriContaminated, VerilogEval, RTLLM, CVDP, ProtocolLLM, OpenRTLSet, MG-Verilog, LLM-EDA OpenCores, Hardware VerilogEval v2, LLM_4_Verilog, CodeV-R1, EvolVE/IC-RTL, SafeTune, TrojanLoC/TrojanInS, HarmChip, LLMSanitize, Min-K% probability contamination detection | Capture benchmark hygiene targets only; block public benchmark imports, held-out E1 prompt export, model runs, contamination-detector runs, security-jailbreak prompt runs, score claims, and release use until exact revisions, task hashes, license review, non-overlap reports, near-duplicate checks, simulator/synthesis/formal logs, seeds, evaluator versions, dual-use review, and reviewer disposition exist. |
| Spec traceability and requirement coverage | IncreRTL, LLM-FSM, Spec2Assertion, CoverAssert, Qimeng-CodeV-SVA, AssertionForge, SANGAM, CodeV-SVA, ProtocolLLM | Capture requirements-to-RTL traceability targets only; block spec edits, RTL edits, generated trace matrices, generated SVAs, model runs, parser runs, formal/simulation/synthesis claims, and release use until stable requirement IDs, source hashes, non-overlap review, vacuity checks, deterministic gates, and reviewer disposition exist. |
| IP, register-map, and platform-contract automation | SystemRDL, PeakRDL, PeakRDL IP-XACT, OpenTitan Reggen, IP-XACT, FuseSoC, Edalize, Bender, SiliconCompiler, RgGen | Capture IP/register/contract targets only; block external IP import, generator runs, generated RTL/headers/docs/IP-XACT/SystemRDL, memory-map or ABI edits, and release use until revisions, licenses, file manifests, generated output hashes, ABI diffs, platform/Linux/software contract gates, RTL/cocotb/synthesis evidence, and review exist. |
| Repo-aware RTL assistance | RTLRepoCoder, ORAssistant-style retrieval | Build citation-required local RAG over E1 sources before any completion workflow. |
| RTL optimization and equivalence | SymRTLO, RTLRewriter-Bench, FormalRTL, timing logic metamorphosis, OpenABC-D, RocketPPA | Capture equivalence and before/after PPA target tasks only; block generated rewrites, equivalence claims, and PPA claims until local lint, simulation, formal/SAT equivalence, synthesis, OpenLane, and review evidence exist. |
| Circuit foundation models and embeddings | Circuit foundation model survey, ChipNeMo, GenEDA, NetTAG, DeepGate4, ChipLingo | Capture corpus governance, multimodal embedding, netlist-function reasoning, and domain-adapted EDA LLM targets only; block training, embeddings, inference, corpus export, model-quality claims, and design decisions until local provenance, held-out tasks, deterministic gates, and review exist. |
| Physical design prediction | CircuitNet, CircuitNet 2.0, RoutePlacer | Capture local E1 PD feature/label manifests; predictors remain advisory. |
| Placement optimization | AlphaChip/Circuit Training, TILOS MacroPlacement, AutoDMP, DREAMPlace | Use as experiment references; compare only after routed OpenLane evidence. |
| Verification stimulus | LLM4DV, CVDP-style agent tasks, local cocotb coverage bins | Generate candidate ideas only; accept by `make cocotb-npu` and `make cocotb-contract`. |
| Assertion generation | AssertLLM, AssertionForge, CodeV-SVA | Keep proposed SVAs as reviewed candidates; require formal/simulation evidence before binding. |
| Verification planning and formal debug | PRO-V, Saarthi, SANGAM, FVDebug, SiliconMind-V1, UVMarvel | Capture spec-to-plan, formal counterexample triage, testbench/oracle candidates, UVM/subsystem testbench automation, assertion self-refinement, and patch quarantine targets; no generated patch, testbench, UVM collateral, assertion, coverage claim, root-cause claim, or closure claim without local gates and review. |
| Simulator/NPU DSE | ZigZag, Timeloop/Accelergy, DOSA, DiffAxE | Use hashed architecture manifests; block claims until calibrated measurements exist. |
| Simulator/benchmark targets | ZigZag, Timeloop/Accelergy, DOSA, RTLMUL | Capture local benchmark/runtime targets; block performance claims until logs exist. |
| Software BSP, firmware, and boot simulation | LLM firmware validation, EoK RISC-V kernel optimization, IntrinTrans RVV, OpenSBI, U-Boot, MCP4EDA | Capture boot/BSP/firmware target tasks only; block generated patches, device-tree edits, boot claims, BSP claims, and kernel-performance claims until build logs, QEMU/Renode transcripts, static analysis, and review exist. |
| Compiler autotuning and codegen | LLVM MLGO, Google ML Compiler Opt, TVM MetaSchedule, Ansor, AutoFDO, LLVM Propeller, BOLT, IntrinTrans, VecIntrinBench, SimdBench, Agentic Code Optimization, HINTPILOT, LLM-VeriOpt, xDSL RVV lowering | Capture compiler-model, RVV intrinsic, tensor-kernel schedule, profile-guided binary, and agentic optimization targets only; block generated code, compiler/pass changes, profile data, relinked binaries, autotuner/model execution, and performance claims until toolchain, correctness, simulator, benchmark, and review gates pass. |
| Reliability, aging, EM, and soft errors | PROTON, EMspice 2.0, NBTI/HCI aging models, SOFIA, Ethos-U55 soft-error study, Ibex SEU formal evaluation, BEC, Hamartia, FIES, TensorFI, Ares, Caliptra error-injection requirements | Capture aging, EM, formal/QEMU fault-injection, NPU workload resilience, compiler reliability, and ECC/TMR mitigation targets only; block fault injection, aging/EM analysis, generated mitigation, signoff, and reliability claims until process models, mission profiles, fault manifests, simulator/formal logs, PD/signoff evidence, before/after PPA, and review exist. |
| RTL PPA advisory | RTLMUL, VerilogEval, CVDP, DeepCircuitX, CktEvo | Capture local RTL and synthesis hashes only; do not load weights, import repo-level RTL/PPA datasets, generate RTL evolution edits, or emit PPA predictions without revision pinning, license review, equivalence/simulation/synthesis gates, and held-out E1 error analysis. |
| HLS and accelerator DSE | HLSFactory, HLS-Eval, LLM-DSE, iDSE, SECDA-DSE | Capture E1 HLS candidate tasks from runtime/spec inputs; block generated directives, HLS, and RTL until C-sim, HLS synthesis, RTL simulation, synthesis, equivalence where applicable, and review pass. |
| Timing closure and ECO | TimingPredict, E2ESlack, TimingLLM, FluxEDA, AstroTune, OpenROAD Resizer, OpenPhySyn, learning-driven gate sizing, FusionSizer, ICCAD 2024 gate-sizing benchmark, IR-aware ECO RL, Open-LLM-ECO | Capture SDC, metrics, STA, resizer logs, PD evidence, and blocked AST/retrieval-assisted cross-stage parameter tuning plus gate-sizing/buffering/pin-swap/clone ECO boundaries for advisory timing triage; block constraint/config/ECO edits until before/after OpenSTA/OpenLane, power, DRC, antenna, manufacturing, and signoff gates pass. |
| Routing, congestion, and DRC | CircuitNet, RoutePlacer/RouteGNN, OpenROAD FastRoute, OpenROAD TritonRoute, CU-GR, Dr.CU | Capture global-route, detailed-route, DRC, antenna, wirelength, guide, DEF/ODB, and signoff hashes for advisory routability triage; block route guides, DEF/ODB/GDS, Tcl, DRC fixes, router sweeps, and predictor claims until before/after routing, STA, power, manufacturing, and signoff gates pass. |
| Clock tree and clock network | OpenROAD CTS, TritonCTS, GAN-CTS, CTS-Bench, OpenROAD two-phase clocking conversion | Capture CTS, clock, skew, post-CTS timing, DEF/ODB, constraints, and signoff hashes for advisory skew/latency/hold-risk triage; block generated clock trees, SDC/Tcl, useful-skew settings, and clocking conversion until before/after STA, DFT, CDC/RDC, power, routing, manufacturing, and signoff gates pass. |
| Extraction, SPEF, and parasitics | OpenROAD OpenRCX, OpenLane timing-corner flow, Magic extraction, CapBench | Capture OpenRCX SPEF, RCX logs, Magic extracted SPICE, SDF, timing-corner manifests, and multi-corner STA evidence for advisory parasitic/SI triage; block generated SPEF/SDF/SPICE, extraction rules, SI waivers, RC predictions, and timing claims until before/after extraction, STA, DRC/LVS, antenna, route, power, and signoff gates pass. |
| CDC/RDC and reset-domain signoff | Accellera CDC/RDC standard, formal CDC MSI methodology, Questa CDC/RDC Assist, OpenCDC, MCP4EDA | Capture clock/reset-domain target tasks only; block generated constraints, waivers, classifications, and signoff claims until local intent, deterministic CDC/RDC reports, reset-domain regressions, and review exist. |
| Analog and mixed-signal | ALIGN, AutoCkt, GENIE-ASI, ACDC, ADO-LLM, AnalogGenie, Masala-CHAI, LIMCA | Capture padframe/package/SI-PI/IO targets only; block generated SPICE, analog layout, foundry IP, and analog IMC claims until SPICE, DRC/LVS, extraction, package, and human review evidence exists. |
| Memory, interconnect, and NoC DSE | ArchGym, AI NoC DSE, BookSim2, Ramulator2, DRAMsim3, DRAMSys, gem5-Aladdin, Gem5-AcceSys | Capture E1 memory/fabric target tasks and backend availability; block fabric, memory-map, coherency, QoS, and DRAM claims until local contract, simulator, benchmark, and RTL evidence exists. |
| CPU microarchitecture AI | Agentic Architect, PerfVec, Concorde, ChampSim, BranchNet, LLBP, Pythia, Mockingjay, Drishti | Capture branch predictor, cache replacement, prefetcher, CPU performance-model, and simulator-backed DSE targets only; block generated RTL, simulator/model execution, trace import, IPC/MPKI/area/power/product claims, and release use until local traces, before/after simulator logs, RTL/cocotb/formal/synthesis, benchmark evidence, and review exist. |
| DFT, ATPG, and manufacturing test | Fault DFT, VeriRAG/LLM4DFT, DeepTPI, DEFT, LITE scan instrumentation, DRL ATPG, ATPG via AI survey, ATPG Toolkit, NN-for-ATPG | Capture DFT/ATPG target tasks only; block scan insertion, test-point insertion, RTL testability repairs, generated patterns, and fault-coverage claims until netlist, scan policy, DFT-rule oracle, ATPG, manufacturing, and signoff evidence exists. |
| Power, thermal, IR drop, and PDN | DeepOHeat, 2D-ThermAl, ThermEDGe/IREDGe, WACA-UNet, IR-Drop-Predictor, EDA IR-Drop Prediction, OpeNPDN, AiEDA, RTLMUL | Capture power/thermal/PDN target tasks only; block generated power maps, thermal maps, PDNs, IR-drop predictions, TOPS/W, and thermal claims until measured traces, package models, PDNSim/OpenROAD labels, and signoff evidence exist. |
| Hardware security | AI-assisted hardware security verification survey, Hardware Trojan ML, PEARL, TrojanSAINT, GNN-MFF, SecureRAG-RTL, SafeTune, TrojanLoC, HarmChip, Trojan explainability comparison, TrojanWhisper, TrojanGYM, GHOST Benchmarks | Capture local RTL/security target tasks only; block scanner execution, prompt red-team runs, poisoned-corpus import, Trojan insertion, vulnerability claims, generated-RTL trust claims, and release use until labels, deterministic regressions, provenance, prompt isolation, and human security review exist. |
| Board, package, manufacturing, and FPGA | PCBSchemaGen, PCB-Bench, PCBAgent, NeurPCB, PCB-Migrator, PCB-PR-App, Freerouting, DREAMPlaceFPGA, RapidWright FPGA interchange, DeepPCB defect dataset | Capture local package, KiCad, FPGA, Wi-Fi/RF, and manufacturing target tasks only; block generated schematics, board placement/routing, Gerbers, package/pinout edits, FPGA output, fabrication claims, inspection claims, and release use until deterministic gates and review evidence exist. |
| DFM, yield, lithography, and OPC | Litho-aware ML hotspot detection, DLHSD, LithoHoD, TorchLitho, OpenILT, DiffOPC, RadAI WM-811K wafer defect model, Pegasus LPA | Capture hotspot-screening, differentiable lithography, ILT/OPC, signoff-feature, and wafer-defect targets only; block layout/mask/OPC edits, lithography simulation, model execution, DFM/yield/mask/wafer-defect claims, and release use until foundry/process collateral, local layout labels, deterministic signoff gates, and review exist. |
| Post-silicon validation and bring-up | Symbolic QED, SoC trace protocol debug, RISC-V DV, RISCOF, RISC-V architectural tests, OpenTitan chip tests, RISC-V Debug Specification, OpenOCD, sigrok-cli, ML/XAI boot-failure debug, LLM4SecHW | Capture post-silicon, FPGA, RISC-V compliance, RISC-V debug, trace-debug, and lab-evidence targets only; block generated lab scripts, test binaries, hardware runs, compliance/debug claims, silicon bring-up claims, and release use until local logs, traces, signatures, probe identity, board/silicon IDs, and review exist. |
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
    to capture timing-closure inputs, OpenLane STA/resizer evidence, and
    blocked gate-sizing/buffer-insertion/pin-swap/clone ECO boundaries before
    any AI-assisted constraint review or ECO-search loop is allowed to write.
13. Use `scripts/ai_eda/capture_routing_congestion_targets.py --run-id validation`
    to capture route-log, global-route guide, detailed-route DRC, antenna,
    wirelength, and signoff inputs before any AI-assisted router sweep,
    routability predictor, route-guide edit, or DRC-fix loop is allowed to
    write.
14. Use `scripts/ai_eda/capture_clock_tree_targets.py --run-id validation`
    to capture CTS, clock, skew, post-CTS timing, DEF/ODB, constraint, and
    signoff inputs before any AI-assisted CTS tuning, useful-skew prediction,
    clock-tree generation, SDC/Tcl generation, or clocking conversion is allowed
    to write.
15. Use `scripts/ai_eda/capture_extraction_parasitic_targets.py --run-id validation`
    to capture OpenRCX SPEF, RCX logs, Magic extracted SPICE, SDF, timing-corner,
    and multi-corner STA inputs before any AI-assisted parasitic model,
    SPEF/SDF/SPICE generation, extraction-rule edit, SI waiver, or timing-claim
    loop is allowed to write.
16. Use
    `scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation`
    to keep analog/AMS automation tied to local padframe, package, Wi-Fi IO,
    SI/PI, and process blockers before any SPICE/layout/IP generator is allowed.
16. Use
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
    methods, cross-target on-device tests, RISC-V debug/OpenOCD flows, sigrok
    lab capture, boot-failure triage, FPGA bring-up, and lab automation tied to
    local QEMU/Renode, FPGA, package/board, manufacturing, real-world,
    benchmark, and release gates before any generated lab script, test binary,
    hardware action, compliance/debug claim, or silicon bring-up claim is
    allowed.
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
28. Use `scripts/ai_eda/capture_compiler_autotuning_targets.py --run-id validation`
    to keep LLVM MLGO, TVM/Ansor schedule search, RVV intrinsic generation,
    profile-guided binary optimization, and agentic compiler optimization tied
    to local compiler pins, runtime tests, RVV autovec checks, benchmark
    calibration, simulator/runtime logs, and review before any generated code,
    profile, binary, or compiler-performance claim is allowed.
29. Use `scripts/ai_eda/capture_reliability_resilience_targets.py --run-id validation`
    to keep aging, EM, soft-error, formal/QEMU fault-injection, NPU workload
    resilience, and ECC/TMR mitigation work tied to process models, mission
    profiles, deterministic fault manifests, simulator/formal logs, PD/signoff
    evidence, before/after PPA, and review before any fault campaign,
    mitigation, signoff, or reliability claim is allowed.
30. Use `scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation`
    to keep HuggingFace/GitHub models and corpora in metadata-only target
    capture. Do not download weights or datasets, train, fine-tune, run
    inference, run evaluation, export local corpora, generate source, or make
    model/dataset quality claims without exact revisions, licenses, manifests,
    contamination checks, quarantine paths, deterministic local gates, and
    review.
31. Use `scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation`
    to keep VerilogEval, RTLLM, CVDP, ProtocolLLM, external RTL corpora, and
    contamination-detection methods behind benchmark governance. Do not import
    public benchmarks, export held-out E1 prompts, run models, run
    contamination detectors, generate RTL, or make score/model-quality claims
    without exact revisions, license review, task hashes, non-overlap reports,
    near-duplicate checks, deterministic local gates, and review.
32. Use `scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation`
    to keep MCP-style EDA wrappers, write-capable agents, commercial copilots,
    and hardware-agent benchmarks behind command governance. Do not start MCP
    servers, call external AI APIs, invoke open-source or commercial EDA tools,
    generate Tcl/shell/constraints/waivers/source, or make productivity, PPA,
    signoff, or release claims without typed command schemas, explicit scopes,
    license and data-handling review, local replay manifests, deterministic
    gates, and review.
33. Use `scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation`
    to keep requirements-to-RTL trace matrices, NL-to-SVA, FSM/protocol
    generation, and incremental spec-evolution assistance behind stable
    requirement IDs. Do not change specs, RTL, assertions, testbenches, or
    generated software contracts, and do not claim requirement coverage,
    assertion quality, or traceability closure without source hashes,
    non-overlap review, vacuity checks, deterministic local gates, and review.
34. Use `scripts/ai_eda/capture_ip_register_contract_targets.py --run-id validation`
    to keep register-description languages, IP-XACT metadata, register
    generators, and IP dependency managers behind the existing E1 platform
    contract. Do not import external IP, run generators, edit memory maps,
    headers, device trees, drivers, or RTL, or claim register correctness
    without revisions, license review, generated output hashes, ABI diffs,
    deterministic local gates, and review.
35. Use `scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation`
    to keep OpenRAM, DFFRAM, CACTI, DESTINY, NVSim, NeuroSim, OpenROAD memory
    macro flow references, and SRAM yield/Vmin watchlists behind local PDK and
    memory evidence gates. Do not download PDKs or macros, import external
    macros, run memory compilers or estimators, edit RTL/PD/library collateral,
    generate BIST/repair collateral, or claim area, timing, power, Vmin, yield,
    signoff, or release readiness without exact revisions, generated artifact
    hashes, DRC/LVS/extraction, STA, OpenLane evidence, deterministic local
    gates, and review.
36. Use `scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id validation`
    to keep chiplet partitioning, 2.5D/3DIC placement/topology, UCIe/die-to-die
    standards, package metadata exchange, cost/yield models, and LLM/agentic
    chiplet co-design work behind E1 package and architecture gates. Do not
    generate chiplet partitions, interposer layouts, package/bump maps,
    die-to-die interfaces, SI/PI/thermal models, RTL, PD configs, board/package
    edits, simulator outputs, or cost/yield/performance/signoff claims without
    exact revisions, source/license review, architecture constraints, local
    deterministic gates, and review.
37. Use `scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation`
    to keep Yosys, ABC, logic-network libraries, OpenABC-D/OpenLS-DGF-style
    datasets, and ML/RL/Bayesian synthesis recipe search behind local synthesis
    and equivalence gates. Do not generate or apply ABC/Yosys recipes,
    technology mappings, constraints, netlists, or gate-level rewrites, and do
    not claim area, timing, power, equivalence, signoff, or release improvement
    without exact tool/model revisions, source/script hashes, output hashes,
    formal or equivalence evidence, deterministic synthesis/STA/OpenLane/power
    gates, and review.
38. Use `scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation`
    to keep EQY, Yosys equiv_* flows, ABC CEC, CIRCT LEC, and current datapath
    CEC research behind local LEC harness governance. Do not generate miters,
    equivalence scripts, waivers, proof logs, RTL, netlists, synthesis recipes,
    or optimization patches, and do not claim equivalence, timing, QoR,
    signoff, or release readiness without exact tool/solver revisions, input
    and output hashes, black-box/memory/reset/x-propagation/hierarchy
    assumptions, counterexample triage, deterministic synthesis/formal/
    simulation/STA/OpenLane/power gates, and review.
39. Use `scripts/ai_eda/capture_physical_verification_targets.py --run-id validation`
    to keep KLayout DRC, Magic DRC/LVS, Netgen LVS, OpenROAD antenna checking,
    Rule2DRC-style generated deck research, and post-EDA repair benchmarks
    behind physical-verification governance. Do not generate or run DRC decks,
    layout repairs, LVS waivers, antenna fixes, Tcl, patches, or AI signoff
    triage, and do not claim DRC, LVS, antenna, physical signoff, or release
    readiness without exact tool revisions, rule-deck hashes, layout/netlist
    hashes, before/after logs, deterministic extraction/STA/power/
    manufacturing/commercial-EDA gates where applicable, and review.
40. Use `scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation`
    to keep OpenROAD GPL/DPL, AlphaChip/Circuit Training, TILOS MacroPlacement,
    AutoDMP, DREAMPlace, Xplace, ChipDiffusion, DiffPlace, FlowPlace,
    ChiPBench-D, and RoutePlacer behind placement-governance gates. Do not
    generate or apply placements, density changes, padding changes,
    macro-placement edits, legalizer changes, filler choices, Tcl, patches, or
    benchmark imports, and do not claim placement QoR, timing, routability,
    signoff, or release readiness without exact tool/model/data revisions,
    config and layout hashes, legalizer reports, downstream routing/STA/
    physical-verification/power/manufacturing gates, and review.
41. Use `scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation`
    to keep OpenROAD floorplan initialization, IO pin placement, tap/endcap,
    PDN generation, OpenLane floorplanning, FloorSet, Piano, IBM FP-OPT,
    NL2GDS-style agents, and OpeNPDN behind early-physical-planning gates. Do
    not generate or apply die/core areas, floorplans, macro placements, pin
    orders, padframes, tap/endcap settings, tracks, PDN grids, DEF/ODB/GDS,
    Tcl, patches, or benchmark imports, and do not claim floorplan, pinout,
    PDN, signoff, or release readiness without exact revisions, config/layout
    hashes, package and padframe cross-probe, SI/PI, route, STA,
    DRC/LVS/antenna, power, manufacturing, commercial-EDA where applicable, and
    review.

## Current Blockers

- Local RTL checking is blocked until Verilator or Icarus Verilog is available.
- OpenLane evidence is blocked while the current run is incomplete or locked.
- No AI-generated RTL, stimulus, placement, or predictor output has been
  accepted into source.
- License review is still required for external code, datasets, and model
  weights.
