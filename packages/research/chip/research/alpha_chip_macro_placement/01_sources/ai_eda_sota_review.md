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
  claims require runtime-contract, phase-gate, benchmark, synthesis, and simulator
  evidence.
- Memory, interconnect, NoC, and accelerator-system simulation are strong
  candidates for AI-guided design-space exploration, but only after the E1
  memory/fabric contracts define valid knobs. ArchGym, BookSim2, Ramulator2,
  DRAMsim3, DRAMSys, gem5, Sniper, gem5-Aladdin, and Gem5-AcceSys are useful
  references; the current E1 AXI-Lite SRAM-backed scaffold makes them
  target-capture only.
- CPU microarchitecture search is now an explicit AI lane. Agentic Architect
  extends the agentic-EDA idea into branch predictors, cache replacement, and
  prefetching; PerfVec and Concorde show fast CPU performance modeling; gem5
  and Sniper frame CPU/cache/memory simulator experiments; and BranchNet,
  Pythia, Mockingjay, Drishti, LLBP, and ChampSim are useful SOTA references.
  E1 should keep this behind trace provenance, simulator logs, before/after
  RTL, cocotb/formal/synthesis, and benchmark gates.
- Compiler and code-generation automation is a separate evidence surface from
  BSP work. LLVM MLGO, LLVM/MLIR, IREE, TVM MetaSchedule/Ansor, ExecuTorch,
  LiteRT, XNNPACK, AutoFDO/Propeller/BOLT, IntrinTrans/VecIntrinBench/SimdBench,
  Autocomp, AccelOpt, V-Seek, RISC-V Interaction Tree semantics, and agentic
  compiler optimization can improve shipped binaries, RVV/NPU kernels, or edge
  model deployment paths, but E1 needs pinned toolchains, generated
  MLIR/VMFB/PTE/model/binary/profile hashes, prompt/model revisions,
  optimization-memory quarantine, unsupported-op and CPU-fallback reports,
  semantic tests, simulator/runtime logs, calibrated benchmarks, and review
  before generated code, kernels, profiles, memories, runtime paths, or proof
  claims are used.
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
- DTCO, TCAD, DFM, yield, lithography, OPC, and wafer-defect AI are important
  but sit beyond ordinary PD prediction. TCAD agents and executable TCAD LLMs
  must not generate E1 device/process assumptions without authorized decks,
  simulators, calibration, raw logs, and process-device review. Hotspot
  detectors, differentiable lithography, ILT/OPC optimizers, and wafer-map
  classifiers need foundry decks, process windows, mask rules, final layout,
  local labels, and manufacturing evidence; otherwise they are research context
  and target capture only.
- Post-silicon validation and lab-debug automation must stay explicit rather
  than being folded into simulator success. RISC-V architectural tests, RISCOF,
  riscv-dv, ISA coverage libraries, generative RISC-V fuzzing, FPGA-assisted
  CPU validation, QED-style methods, SoC trace-debug reconstruction,
  cross-target on-device tests, and ML/XAI boot-failure classification are
  useful only after E1 has pinned suites, target identities, logs, signatures,
  coverage databases, traces, bitstreams, board/FPGA revisions, and real-world
  evidence.
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
| Agentic EDA orchestration | Agentic EDA survey, AutoEDA, EDA-MCP Server, ChatEDA, LLM-powered EDA log analysis, MCP4EDA, FluxEDA, iScript, Synopsys.ai Copilot, Cadence JedAI, Cadence ChipStack AI Super Agent, Siemens Fuse EDA AI Agent, Phoenix-bench, HWE-Bench, PostEDA-Bench, EDA-Schema-V2, AuDoPEDA, OpenROAD MCP | Keep read-only RAG and dry-run runners first; require typed command schemas, explicit scopes, commercial license review, sandbox/authentication policy, memory/schema redaction, archived log/schema hashes, output hashes, generated-script quarantine, deterministic replay, and reviewer disposition before write-capable agents, MCP sessions, physical-design Tcl generation, stateful memory/skill reuse, schema-normalized tool contexts, post-EDA repair, coding-agent tool patches, or generated fixes. |
| RTL generation | RTL-Coder, VeriGen, OriGen, VeriReason, DeepV, ChipCraftX RTLGen 7B, ChipSeek, CircuitMind/TC-Bench, RTLSeek, QiMeng-CodeV-R1, QiMeng-CRUX, QiMeng-SALV, EvolVE, VeriAgent, RTLFixer, PyHDL-Eval, OpenLLM-RTL, VerilogEval, CVDP | Evaluate against small E1-style tasks; block generated or repaired RTL/netlists, multi-agent/RAG generation, LoRA loading, RL training/reward loops, hosted-space prompt export, constrained or signal-aware generation, evolutionary search, evolving-memory loops, inference, and PPA claims until lint, simulation, synthesis, formal where applicable, contamination checks, benchmark-overlap review, and review pass. |
| External models and corpora | OpenRTLSet, MG-Verilog, DeepCircuitX, MetRex, CircuitNet 3.0, VeriGen, OriGen, VeriReason, DeepV, VeriForge, LLM-EDA OpenCores, Hardware VerilogEval v2, LLM_4_Verilog, RTLFixer, PyHDL-Eval, SiliconMind-V1, ChipCraftX, ChipSeek, CircuitMind/TC-Bench, RTLSeek, QiMeng-CodeV-R1, QiMeng-CRUX, QiMeng-SALV, EvolVE, VeriAgent, SafeTune, TrojanLoC, CodeV-SVA, RadAI WM-811K | Capture HuggingFace/GitHub model, corpus, repair-loop, RAG, and multi-HDL benchmark intake targets only; block downloads, imports, training, fine-tuning, inference, hosted prompt submission, evaluation, generated source, repaired source, and release use until exact revisions, licenses, manifests, model-card/base-model/reward/retrieval metadata, poisoning and contamination checks, benchmark-overlap review, quarantine paths, deterministic local gates, and review exist. |
| Benchmark contamination and evaluation hygiene | VeriContaminated, VerilogEval, RTLFixer, PyHDL-Eval, RTLLM, CVDP, ProtocolLLM, VeriGen, OriGen, VeriReason, DeepV, OpenRTLSet, MG-Verilog, LLM-EDA OpenCores, Hardware VerilogEval v2, LLM_4_Verilog, QiMeng-CodeV-R1, QiMeng-CRUX, QiMeng-SALV, EvolVE/IC-RTL, SafeTune, TrojanLoC/TrojanInS, HarmChip, LLMSanitize, Min-K% probability contamination detection | Capture benchmark hygiene targets only; block public benchmark imports, syntax-repair loops, multi-HDL benchmark transfer claims, held-out E1 prompt export, model/RAG runs, contamination-detector runs, security-jailbreak prompt runs, score claims, and release use until exact revisions, task hashes, license review, non-overlap reports, near-duplicate checks, simulator/synthesis/formal logs, seeds, evaluator versions, dual-use review, and reviewer disposition exist. |
| Spec traceability and requirement coverage | IncreRTL, Spec2RTL-Agent, RTLocating/EvoRTL-Bench, LLM-FSM, Spec2Assertion, VERT, STELLAR, ProofLoop, CoverAssert, Qimeng-CodeV-SVA, AssertionForge, SANGAM, CodeV-SVA, ProtocolLLM | Capture requirements-to-RTL traceability targets only; block spec edits, RTL edits, generated trace matrices, generated HLS/RTL/SVAs, model runs, parser runs, formal/simulation/synthesis/HLS claims, and release use until stable requirement IDs, source hashes, non-overlap review, RTL localization impact review, vacuity checks, deterministic gates, and reviewer disposition exist. |
| IP, register-map, and platform-contract automation | SystemRDL, PeakRDL, PeakRDL Regblock, PeakRDL HTML, PeakRDL C Header, PeakRDL UVM, PeakRDL IP-XACT, OpenTitan Reggen, IP-XACT, FuseSoC, Edalize, Bender, SiliconCompiler, RgGen, hdl-registers | Capture IP/register/contract targets only; block external IP import, generator runs, generated RTL/headers/docs/UVM/IP-XACT/SystemRDL, memory-map or ABI edits, and release use until revisions, licenses, file manifests, generated output hashes, ABI diffs, platform/Linux/software contract gates, RTL/cocotb/synthesis evidence, and review exist. |
| Repo-aware RTL assistance | RTLRepoCoder, ORAssistant-style retrieval | Build citation-required local RAG over E1 sources before any completion workflow. |
| RTL optimization and equivalence | SymRTLO, HYPERHEURIST, RTLRewriter-Bench, FormalRTL, timing logic metamorphosis, OpenABC-D, RocketPPA, DynamicSAT, Logic Optimization Meets SAT | Capture equivalence, SAT-solver tuning, SAT preprocessing, and before/after PPA target tasks only; block generated rewrites, simulated-annealing RTL/PPA search, transformed SAT/circuit instances, equivalence claims, runtime claims, and PPA claims until local lint, simulation, formal/SAT equivalence, synthesis, OpenLane, witness replay, and review evidence exist. |
| Circuit foundation models and embeddings | Circuit foundation model survey, ChipNeMo, GenEDA, NetTAG, DeepGate4, ChipLingo, ForgeEDA, GNN4CIRCUITS, HW2VEC | Capture corpus governance, multimodal embedding, AIG/RTL/gate graph extraction, netlist-function reasoning, and domain-adapted EDA LLM targets only; block training, embeddings, inference, corpus export, graph-corpus import, model-quality claims, and design decisions until local provenance, graph-schema hashes, held-out tasks, deterministic gates, and review exist. |
| Physical design prediction | CircuitNet, CircuitNet 2.0, RoutePlacer | Capture local E1 PD feature/label manifests; predictors remain advisory. |
| Placement optimization | OpenROAD GPL/DPL/RTLMP, AlphaChip/Circuit Training, TILOS MacroPlacement, AutoDMP, DREAMPlace, Xplace, ChipDiffusion, DiffPlace, FlowPlace, ChiPBench-D, RoutePlacer, WireMask-BBO, BBOPlace-Bench, Macro Placement Challenge 2026 | Capture placement, legalization, density, macro-placement, BBO, and benchmark targets only; block generated placements, macro placements, benchmark imports, model runs, Tcl/config edits, QoR claims, and release use until local OpenLane/OpenROAD replay, legalizer, routing, STA, DRC/LVS/antenna, PDN/power, benchmark non-overlap, and review gates pass. |
| Verification stimulus | LLM4DV, CVDP-style agent tasks, cocotb, cocotb-test, cocotb-bus, cocotb-coverage, pyuvm, cocotbext-axi, local cocotb coverage bins | Generate candidate ideas and coverage/backbone targets only; accept tests, scoreboards, coverage deltas, and protocol checks only through `make cocotb-npu`, `make cocotb-contract`, formal correlation, and review. |
| Assertion generation | AssertLLM, AssertionForge, CodeV-SVA, STELLAR, ProofLoop, VERT, Surelog/UHDM, Verible, sv-tests, slang | Keep proposed SVAs as reviewed candidates; require parser/lint/elaboration diagnostics, unsupported-construct reports, retrieval/proof logs, vacuity review, and formal/simulation evidence before binding. |
| Verification planning and formal debug | PRO-V, AutoBench, CorrectBench, Project Ava, HAVEN, UVLLM, UVM2, VerifLLMBench, Saarthi, SANGAM, STELLAR, ProofLoop, MEIC, FVDebug, AssertSolver, VeriDebug, SiliconMind-V1, RTLFixer, R3A, Clover RTL Repair, UVMarvel, VerilogCoder, Waveform MCP, MCP VCD, VaporView, WaveEye, cocotb, cocotb-test, cocotb-bus, cocotb-coverage, pyuvm, cocotbext-axi, Surelog/UHDM, Verible, sv-tests, slang | Capture spec-to-plan, formal counterexample triage, self-correcting testbench/oracle candidates, syntax-repair loops, simulation-repair loops, UVM/subsystem testbench automation, UVM benchmark governance, AST/waveform tracing, waveform-context MCP/viewer triage, deterministic waveform root-cause analysis, cocotb replay, pytest regression packaging, bus drivers/monitors/scoreboards, functional coverage, AXI VIP, SystemVerilog frontend/lint/compliance hygiene, assertion self-refinement and assertion-failure repair, Verilog bug localization/classification, repair-search traces, and patch quarantine targets; no generated patch, repaired RTL, testbench, UVM collateral, assertion, waveform summary, coverage claim, bug-localization claim, root-cause claim, repair claim, or closure claim without local gates and review. |
| Simulator/NPU DSE | ZigZag, Timeloop/Accelergy, SCALE-Sim (pinned to scale-sim-v2 v3.0.0 @ 7fd972e, 2025-08-13: layer/row sparsity, Ramulator + Accelergy integration, multi-core, layout configs; vendored under external/scale-sim-v2/ and driven from benchmarks/sim/run_npu_scale_sim.py via --engine=v3), DOSA, DiffAxE | Use hashed architecture manifests; block claims until calibrated measurements exist. |
| Simulator/benchmark targets | ZigZag, Timeloop/Accelergy, SCALE-Sim, DOSA, GEM, RTLflow, FireSim, SystemC/TLM, SST, Chipyard, Gemmini, FireMarshal, MIDAS/FAME, Verilator, QEMU, Renode, gem5, Sniper, Ramulator2, DRAMsim3, Verion EDA, Copra, McPAT, HotSpot, Waveform MCP, MCP VCD, VaporView, cocotb, cocotb-test, cocotb-bus, cocotb-coverage, pyuvm, cocotbext-axi, AutoBench, Project Ava, RTLMUL | Capture local benchmark/runtime targets and simulator backend watchlists; block performance, speedup, energy, thermal, generated-testbench, generated full-system RTL/DTS/firmware/workloads, waveform-debug, root-cause, coverage, protocol-check, Linux boot, accelerator, and product claims until local logs, trace/waveform correlation, coverage database hashes, generator/submodule revisions, architecture and memory-simulator configs, version pins, licenses, replay, calibration, platform-contract review, and reviewer disposition exist. |
| Software BSP, firmware, and boot simulation | LLM firmware validation, EoK RISC-V kernel optimization, QEMU, Renode, Verilator, Spike, Sail RISC-V, DTC, Buildroot, IntrinTrans RVV, AUTODRIVER/DRIVEBENCH, OS-R1, AutoOS, FIRMHIVE, ADFEmu, P2IM, DICE, HALucinator, FirmWire, OpenSBI, U-Boot, MCP4EDA | Capture boot/BSP/firmware, Linux-driver, kernel-config, firmware-security, firmware-fuzzing, and firmware re-hosting target tasks only; block generated patches, device-tree edits, driver edits, kernel config edits, build-rootfs edits, simulator/emulator runs, fuzzing runs, vulnerability claims, boot claims, BSP claims, and kernel-performance claims until artifact hashes, firmware-image provenance, HAL/peripheral/interrupt/DMA model manifests, build logs, QEMU/Renode/Verilator/ISS transcripts, DTC warnings, crash replay, static analysis, security replay, and review exist. |
| Compiler autotuning and codegen | LLVM MLGO, Google ML Compiler Opt, LLVM/MLIR, IREE, Apache TVM, TVM MetaSchedule, Ansor, ExecuTorch, LiteRT, XNNPACK, AutoFDO, LLVM Propeller, BOLT, IntrinTrans, VecIntrinBench, SimdBench, Agentic Code Optimization, HINTPILOT, LLM-VeriOpt, xDSL RVV lowering, Autocomp, AccelOpt, V-Seek, RISC-V Interaction Tree Semantics | Capture compiler-model, MLIR/IREE backend, edge-runtime frontend, CPU fallback, RVV intrinsic, tensor-kernel schedule, accelerator-kernel optimization, profile-guided binary, formal-semantics, and agentic optimization targets only; block generated code, compiler/pass changes, generated MLIR/VMFB/PTE/model artifacts, runtime frontend claims, generated kernels, optimization memories, profile data, relinked binaries, proof claims, autotuner/model execution, fallback-hidden acceleration claims, and performance claims until toolchain, correctness, simulator, benchmark, formal, unsupported-op/fallback, and review gates pass. |
| Reliability, aging, EM, and soft errors | AgenticTCAD, TcadGPT, PROTON, EMspice 2.0, NBTI/HCI aging models, SOFIA, Ethos-U55 soft-error study, Ibex SEU formal evaluation, BEC, HDFIT, LLFI, LLTFI, Hamartia, FIES, TensorFI, PyTorchFI, PyTorchALFI, MRFI, Ares, Caliptra error-injection requirements | Capture TCAD/DTCO process-device assumptions, aging, EM, netlist/RTL/formal/QEMU/LLVM/MLIR/workload fault-injection, NPU workload resilience, compiler reliability, and ECC/TMR mitigation targets only; block generated TCAD decks/device assumptions, fault injection, aging/EM analysis, generated mitigation, signoff, and reliability claims until authorized decks, process models, calibration, mission profiles, fault manifests, output classifiers, simulator/formal logs, PD/signoff evidence, before/after PPA, and review exist. |
| RTL PPA advisory | RTLMUL, VerilogEval, CVDP, DeepCircuitX, CktEvo | Capture local RTL and synthesis hashes only; do not load weights, import repo-level RTL/PPA datasets, generate RTL evolution edits, or emit PPA predictions without revision pinning, license review, equivalence/simulation/synthesis gates, and held-out E1 error analysis. |
| HLS and accelerator DSE | HLSFactory, HLS-Eval, HLStrans, SAGE-HLS, Bench4HLS, LLM-DSE, HLSPilot, iDSE, MPM-LLM4DSE, ForgeHLS, DiffHLS, HLS-Seek, TimelyHLS, FlexLLM, TAPA/RapidStream, SECDA-DSE, ScaleHLS, Google XLS, Dynamatic, AutoDSE, AI4DSE, DB4HLS, DP-HLS, hls4ml, FINN, AMD HLS Dataflow Case Study | Capture E1 HLS candidate tasks from runtime/spec inputs; block generated directives, HLS, IR, RTL, imported QoR models, AST-guided generators, proxy reward models, benchmark datasets, HLS libraries, quantized-NN compiler outputs, compiler infrastructure, open HLS backends, DSE baselines/databases, and FPGA backends until revisions, licenses, manifests, benchmark-overlap review, C-sim, HLS synthesis, RTL simulation, synthesis, equivalence where applicable, QoR replay/error analysis, and review pass. |
| Timing closure and ECO | TimingPredict, E2ESlack, TimingLLM, FluxEDA, AstroTune, OpenROAD Resizer, OpenPhySyn, learning-driven gate sizing, FusionSizer, ICCAD 2024 gate-sizing benchmark, IR-aware ECO RL, Open-LLM-ECO, iScript | Capture SDC, metrics, STA, resizer logs, PD evidence, and blocked AST/retrieval-assisted cross-stage parameter tuning plus Tcl-generation and gate-sizing/buffering/pin-swap/clone ECO boundaries for advisory timing triage; block generated Tcl, constraint/config/ECO edits, commercial-tool calls, and QoR claims until before/after OpenSTA/OpenLane, power, DRC, antenna, manufacturing, and signoff gates pass. |
| Routing, congestion, and DRC | CircuitNet, RoutePlacer/RouteGNN, OpenROAD FastRoute, OpenROAD TritonRoute, CU-GR, Dr.CU | Capture global-route, detailed-route, DRC, antenna, wirelength, guide, DEF/ODB, and signoff hashes for advisory routability triage; block route guides, DEF/ODB/GDS, Tcl, DRC fixes, router sweeps, and predictor claims until before/after routing, STA, power, manufacturing, and signoff gates pass. |
| Clock tree and clock network | OpenROAD CTS, TritonCTS, GAN-CTS, CTS-Bench, OpenROAD two-phase clocking conversion | Capture CTS, clock, skew, post-CTS timing, DEF/ODB, constraints, and signoff hashes for advisory skew/latency/hold-risk triage; block generated clock trees, SDC/Tcl, useful-skew settings, and clocking conversion until before/after STA, DFT, CDC/RDC, power, routing, manufacturing, and signoff gates pass. |
| Extraction, SPEF, and parasitics | OpenROAD OpenRCX, OpenLane timing-corner flow, Magic extraction, CapBench, DeepRWCap, NAS-Cap, ML capacitance extraction for interconnect geometry exploration | Capture OpenRCX SPEF, RCX logs, Magic extracted SPICE, SDF, timing-corner manifests, multi-corner STA evidence, ML capacitance dataset/model watchlists, neural-guided random-walk solver methods, and process-parameter exploration boundaries for advisory parasitic/SI triage; block generated SPEF/SDF/SPICE, extraction rules, process-stack assumptions, SI waivers, RC predictions, model runs, and timing claims until before/after extraction, STA, DRC/LVS, antenna, route, power, and signoff gates pass. |
| CDC/RDC and reset-domain signoff | Accellera CDC/RDC standard 1.0, formal CDC MSI methodology, Questa CDC/RDC Assist, OpenCDC, Veryl clock-domain annotations, Arch AI-native HDL, Sparkle Lean HDL, SKALP, MCP4EDA | Capture clock/reset-domain, typed-HDL, compile-time clock-domain safety, and CDC/RDC orchestration target tasks only; block generated constraints, waivers, classifications, typed-intent translations, generated SystemVerilog/netlists, ML pass-ordering outputs, and signoff claims until local intent, deterministic CDC/RDC reports, reset-domain regressions, equivalence/formal/cocotb replay, and review exist. |
| Analog and mixed-signal | ALIGN, BAG3++, OpenFASOC, laygo2, MAGICAL, AutoCkt, GENIE-ASI, ACDC, ADO-LLM, AnalogGenie, Masala-CHAI, LIMCA, AnalogAgent, AutoSizer, EasySize, self-calibrating sizing equations, ngspice, PySpice, Xyce, OpenVAF, EEsizer, AnalogMaster, VLM-CAD, CircuitLM, EEschematic, AnalogCoder-Pro, AnalogCoder, AMS-Net, Analog Layout VLM Dataset, Analog SPICE Circuits on SKY130, SPICEPilot, AnalogSeeker | Capture padframe/package/SI-PI/IO, analog-agent, schematic parsing, sizing, design-equation, deterministic SPICE replay, analog generator/layout backend replay, model-compilation, SPICE-benchmark, model/corpus-intake, and dataset-governance targets only; block generated SPICE, schematics, CircuitJSON, analog layout, foundry IP, simulator execution, generator execution, external model inference, corpus imports, and analog IMC claims until exact prompts/models/memory/search traces, simulator/model/deck revisions, generator/template/technology provenance, SPICE decks, generated-output hashes, PVT/corner sweeps, DRC/LVS, extraction, package/SI-PI, dataset/model provenance, split/non-overlap review, and human analog review evidence exist. |
| Memory, interconnect, and NoC DSE | ArchGym, AI NoC DSE, AI-driven NoC DSE 2512.07877, NOCTOPUS, FlooNoC, AutoNoC, MICSim, MemExplorer, LUMINA, DeepStack, Mess, BookSim2, Ramulator2, DRAMsim3, DRAMSys, gem5, Sniper, gem5-Aladdin, Gem5-AcceSys | Capture E1 memory/fabric target tasks, inverse ML/diffusion NoC dataset boundaries, memory-system simulator backends, CPU/cache/memory architecture simulator replay, agentic NPU memory hierarchy DSE, LLM bottleneck analysis, stacked-AI accelerator context, and backend availability; block fabric, memory-map, coherency, QoS, NoC parameter generation, model training, generated architecture edits, DRAM/CIM/memory-bandwidth claims, and release use until local contract, topology constraints, traffic traces, simulator replay, benchmark, and RTL evidence exists. |
| Memory macro, SRAM compiler, standard-cell, and CIM library automation | OpenRAM, DFFRAM, SRAM22 Sky130 macros, VLSIDA Sky130 SRAM macros, OpenXRAM, OpenRRAM, CACTI, DESTINY, NVSim, NeuroSim, OpenACM, OpenACMv2, AutoCellGen, TOPCELL, CPCell, CharLib, LibreCell, xcell, NVCell, OpenROAD memory macro flow references, OpenYield, Logic BIST MBIST/BISR, configurable MBIST engines, SRAM fault models, AutoMBIST | Capture memory compiler, open macro collateral, cache/SRAM/emerging-memory estimator, SRAM-CIM compiler, standard-cell synthesis/layout/characterization, surrogate co-optimization, yield/Vmin benchmark, MBIST/BISR, SRAM fault-model, and wrapper-generation targets only; block PDK/macro downloads, imported macros/cells, generated macros/cells, generated CIM architectures, estimator/model runs, Liberty/LEF/GDS/SPICE/RTL/PD edits, BIST/repair collateral, generated wrappers, PPA/accuracy/Vmin/yield/signoff claims, and release use until exact revisions, process/device authority, generated collateral hashes, DRC/LVS/extraction, characterization, STA, OpenLane, workload replay, memory-test replay, local macro/cell tests, and review exist. |
| CPU microarchitecture AI | Agentic Architect, PerfVec, Concorde, gem5, Sniper, ChampSim, BranchNet, LLBP, Pythia, Mockingjay, Drishti | Capture branch predictor, cache replacement, prefetcher, CPU performance-model, CPU/cache/memory architecture simulator, and simulator-backed DSE targets only; block generated RTL, simulator/model execution, trace import, IPC/MPKI/area/power/product claims, and release use until local traces, pinned configs/workloads/stats, before/after simulator logs, RTL/cocotb/formal/synthesis, benchmark evidence, and review exist. |
| DFT, ATPG, and manufacturing test | Fault DFT, OpenROAD DFT, Atalanta, Fault hardware testing, VeriRAG/LLM4DFT, DeepTPI, HighTPI, explainable GNN TPI, X-source GNN testability, DEFT, InF-ATPG, LITE scan instrumentation, DRL ATPG, ATPG via AI survey, ATPG Toolkit, FAN_ATPG, Quaigh, NN-for-ATPG, Logic BIST MBIST/BISR, configurable MBIST, SRAM fault models, AutoMBIST | Capture DFT/ATPG/MBIST target tasks only; block scan insertion, test-point insertion, RTL testability repairs, deterministic or AI ATPG execution, hierarchical/explainable/X-source GNN testability ranking, RL/GNN ATPG policy training, generated MBIST wrappers, memory-repair collateral, generated patterns, fault waivers, and fault-coverage claims until netlist, memory-interface, SRAM fault-model, March-test, fault-list, scan policy, masked-I/O and X-source manifests, DFT-rule oracle, ATPG/MBIST, manufacturing, replay, and signoff evidence exists. |
| Power, thermal, IR drop, and PDN | AgenticTCAD, TcadGPT, DeepOHeat, 2D-ThermAl, Commercial Thermal Map Dataset, HotGauge, McPAT, HotSpot, ThermEDGe/IREDGe, WACA-UNet, LMM-IR, IR-Drop-Predictor, EDA IR-Drop Prediction, PowerNet, MAVIREC, PDNNet, DuST-IRdrop, OpeNPDN, AiEDA, RTLMUL, ArchPower, AutoPower, AtomPower | Capture TCAD-derived device/leakage/self-heating assumptions, measured thermal-corpus intake, deterministic architecture power/thermal backend watchlists, architecture-level CPU/AP and RTL power modeling, and power/thermal/PDN target tasks only; block generated TCAD decks, external dataset imports, power maps, thermal maps, PDNs, static/dynamic IR-drop predictions, architecture/RTL-power estimates, TOPS/W, and thermal claims until authorized process decks, calibration, measured traces, package models, local CPU/AP/RTL feature labels, vector/activity provenance, technology/config manifests, floorplan/power-map hashes, PDN graph extraction, PDNSim/OpenROAD labels, static and dynamic IR-drop replay, dataset/model provenance, and signoff evidence exist. |
| Hardware security | AI-assisted hardware security verification survey, Hardware Trojan ML, VerilogLAVD, HardSecBench, PEARL, HAL, SpyDrNet, Netlist Paths, Naja, TrojanSAINT, GNN-MFF, SecureRAG-RTL, BugWhisperer, VeriCWEty, LASHED, Qihe, SafeTune, TrojanLoC, HarmChip, Trojan explainability comparison, TrojanWhisper, TrojanGYM, NETLAM, GHOST Benchmarks, Hardware Vulnerability Dataset, GoldenFuzz, MABFuzz, Fuzzilicon | Capture local RTL/security target tasks, deterministic gate-level netlist query/review backends, Verilog CWE rule-generation reviews, model-based line-level CWE triage, static-analysis fusion, secure-generation benchmark hygiene, processor-fuzzing security triage, and dual-use dataset/generator governance only; block scanner execution, generated CWE rule import, prompt red-team runs, model downloads/inference, fuzzing runs, static-analysis findings, netlist-query findings, poisoned-corpus import, Trojan insertion/generation, vulnerability claims, generated-RTL trust claims, and release use until labels, RTL/netlist/library hashes, query logs, generated-program hashes, deterministic regressions, mismatch/vulnerability replay, provenance, prompt isolation, non-overlap review, disclosure handling, and human security review exist. |
| Board, package, manufacturing, and FPGA | PCBSchemaGen, OmniSch, Circuitron, PCB-Bench, KiCad, KiBot, KiKit, InteractiveHtmlBom, KiCad StepUp, KiCad JLCPCB Tools, PCBAgent, NeurPCB, PCB-Migrator, MARS-Place, PCB-PR-App, Freerouting, DreamerV3+FR, 3D LineExplore, DREAMPlaceFPGA, OpenPARF, RapidWright FPGA interchange, VTR, OpenFPGA, FABulous, DeepPCB defect dataset, Circuit Weaver, KiCad MCP Pro, KiCad SI Wrapper, Open Schematics, GerberFormer | Capture local package, KiCad, FPGA, Wi-Fi/RF, panelization, assembly/BOM/CPL, ECAD-MCAD exchange, SI/PI simulation-preprocessor, FPGA CAD/fabric-generation, schematic-corpus, AOI-model, and manufacturing target tasks only; block generated schematics, MCP write actions, board placement/routing, Gerbers, package/pinout edits, panel/assembly/vendor exports, mechanical-clearance claims, SI simulation claims, FPGA output, fabric-generation collateral, fabrication claims, inspection claims, model imports, and release use until deterministic gates and review evidence exist. |
| DTCO, TCAD, DFM, yield, lithography, and OPC | AgenticTCAD, TcadGPT, Litho-aware ML hotspot detection, DLHSD, LithoHoD, TorchLitho, OpenILT, DiffOPC, RadAI WM-811K wafer defect model, Pegasus LPA | Capture TCAD/DTCO, hotspot-screening, differentiable lithography, ILT/OPC, signoff-feature, and wafer-defect targets only; block TCAD deck generation, device/process assumptions, layout/mask/OPC edits, lithography simulation, model execution, DFM/yield/mask/wafer-defect claims, and release use until foundry/process collateral, local layout labels, deterministic signoff gates, and review exist. |
| Post-silicon validation and bring-up | Symbolic QED, SoC trace protocol debug, Verilator, Spike, Sail RISC-V, riscv-formal, RISC-V DV, RISCOF, RISC-V architectural tests, riscvISACOV, Lyra, DifuzzRTL, RFUZZ, Cascade, GoldenFuzz, MABFuzz, Fuzzilicon, XFUZZ, DiffTest, FERIVer, OpenTitan chip tests, RISC-V Debug Specification, OpenOCD, sigrok-cli, Spacely, ML/XAI boot-failure debug, LLM4SecHW, LLM4SecHW OSHD, ChipBench | Capture post-silicon, FPGA, RISC-V compliance, ISA/reference-model replay, ISA coverage, RISC-V fuzzing, ML/bandit-guided fuzzer scheduling, coverage-guided RTL fuzzing, CPU co-simulation, FPGA-assisted validation, post-silicon fuzzing, RISC-V debug, trace-debug, LLM hardware-debug benchmark, corpus-governance, and lab-evidence targets only; block generated lab scripts, test binaries, hardware runs, external debug-corpus import, compliance/coverage/debug/vulnerability claims, silicon bring-up claims, and release use until local logs, traces, signatures, generated-program hashes, coverage databases, DUT/reference revisions, bitstreams or lab-authorization records, probe identity, board/silicon IDs, dataset provenance, benchmark replay, disclosure handling, and review exist. |
| Low-power intent, DVFS, and clock gating | IEEE 1801 UPF, IEEE UPF examples, OpenROAD UPF, Yosys `clockgate`, Lighter, OpenROAD clock gating, CODMAS/RTLOPT, RTL-OPT, Prompting for Power, POET, RTL PPA SOG estimation, SymRTLO, PowerGear, OpenSTA power analysis, iEDA iPower, trace2power, ArchPower, AutoPower, AtomPower, OpenROAD two-phase clocking conversion | Capture power-state, UPF, clock-gating, DVFS, retention, isolation, low-power RTL benchmark, HLS power-estimator, VCD/FST/SAIF activity extraction, activity-annotated power-analysis backend, architecture-level CPU/AP and RTL power-prior, and low-power verification targets only; block generated UPF, RTL edits, gated clocks, DVFS policy, retention/isolation insertion, benchmark imports, plugin outputs, power-analysis runs, activity-derived power labels, HLS power labels, model-derived power priors, power-saving claims, and release use until platform, RTL, formal, synthesis, DFT, CDC/RDC, feature mapping, activity provenance, calibration, held-out error analysis, power/thermal, and PD gates exist. |

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
    artifacts, external model/dataset intake, and backend review before any HLS
    generator, QoR model, library import, FPGA backend, or directive-search loop
    is enabled.
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
    and multi-corner STA inputs before any AI-assisted parasitic model, neural
    solver, dataset import, process-parameter exploration, SPEF/SDF/SPICE
    generation, extraction-rule edit, SI waiver, or timing-claim loop is
    allowed to write.
16. Use
    `scripts/ai_eda/capture_analog_mixed_signal_targets.py --run-id validation`
    to keep analog/AMS automation tied to local padframe, package, Wi-Fi IO,
    SI/PI, and process blockers before any SPICE/layout/IP generator is allowed.
16. Use
    `scripts/ai_eda/capture_memory_interconnect_targets.py --run-id validation`
    to keep architecture DSE, NoC, DRAM, generated-fabric, CIM, photonic
    routing, and accelerator-system simulator sources tied to local
    memory/interconnect contracts before any fabric, coherency, QoS,
    memory-map, generated RTL, CIM, photonic, or simulator-backed optimization
    loop is allowed to write.
15. Use `scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation` to
    keep DFT, ATPG, scan, RL/GNN ATPG, and testability AI sources tied to
    local RTL, constraints, fault lists, FFR feature manifests, manufacturing,
    replay, and signoff blockers before any scan insertion, test-point
    insertion, ATPG execution, policy training, or generated pattern flow is
    allowed.
16. Use `scripts/ai_eda/capture_power_thermal_targets.py --run-id validation`
    to keep thermal surrogates, IR-drop predictors, PDN synthesis methods, and
    RTL power priors tied to sustained measurement, package, PD signoff, and
    benchmark blockers before any generated map, PDN edit, TOPS/W, or thermal
    claim is allowed.
17. Use `scripts/ai_eda/capture_hardware_security_targets.py --run-id validation`
    to keep hardware-security, Trojan-detection, RAG triage, CWE rule
    generation, secure-generation benchmarks, and dual-use datasets/generators
    tied to local RTL hashes, formal/simulation gates, no-hardware-action
    policy, non-overlap review, and security review before any scanner output,
    generated rule import, Trojan insertion, generated-RTL trust claim, or
    vulnerability claim is allowed.
18. Use `scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation`
    to keep CDC/RDC standards, formal metastability methodology, ML-assisted
    CDC/RDC setup, typed clock/reset intent methods, formal HDL experiments,
    open CDC anti-pattern lint, and open analyzer candidates tied to local
    clock/reset RTL, SDC, formal, reset-domain regressions, equivalence,
    false-positive triage, and waiver blockers before any generated constraint,
    waiver, translated HDL artifact, classification, tool report, or signoff
    claim is allowed.
19. Use `scripts/ai_eda/capture_software_bsp_firmware_targets.py --run-id validation`
    to keep AI firmware validation, RISC-V kernel optimization, QEMU, Renode,
    DTC, Buildroot, OpenSBI, U-Boot, Linux BSP, and P2IM/DICE/HALucinator/
    FirmWire-style re-hosting work tied to local boot ROM, DTS/DTB, driver,
    simulator, build, artifact-hash, firmware-image provenance, peripheral/
    interrupt/DMA/HAL model, crash-replay, and transcript blockers before any
    generated patch, boot claim, BSP claim, vulnerability claim, or software
    performance claim is allowed.
20. Use `scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation`
    to keep LLM RTL rewrite, symbolic optimization, formal RTL synthesis,
    timing-logic metamorphosis, synthesis datasets, and PPA predictors tied to
    local RTL, formal, cocotb, synthesis, and OpenLane blockers before any
    generated rewrite, equivalence claim, or PPA improvement claim is allowed.
21. Use `scripts/ai_eda/capture_board_package_fpga_targets.py --run-id validation`
    to keep PCB schematic, multimodal schematic QA, KiCad placement/routing,
    KiCad/KiBot/KiKit/BOM/ECAD-MCAD/vendor-output replay, PCB migration,
    world-model/geometric autorouting, FPGA placement/interchange, FPGA
    CAD/fabric-generation, and PCB inspection sources tied to local package,
    board, Wi-Fi/RF, manufacturing, real-world, and FPGA blockers before any
    generated board, package, pinout, panel, BOM, CPL, STEP, Gerber, FPGA,
    fabric, fabrication, assembly, mechanical, or release claim is allowed.
22. Use `scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation`
    to keep IEEE 1801/UPF, OpenROAD UPF, low-power RTL generation, LLM
    clock-gating, Yosys, Lighter, and OpenROAD clock-gating,
    RTL-OPT-style benchmark evaluation, power-first
    RTL optimization, DVFS/idle-state, retention, and isolation sources tied to
    local platform, RTL, formal, synthesis, DFT, CDC/RDC, software/BSP,
    power/thermal, and PD blockers before any generated UPF, gated clock, DVFS
    policy, power-domain artifact, benchmark import, plugin output, or
    power-saving claim is allowed.
23. Use `scripts/ai_eda/capture_verification_debug_targets.py --run-id validation`
    to keep PRO-V, Saarthi, SANGAM, FVDebug, AssertSolver, WaveEye,
    SiliconMind-V1, Surelog/UHDM, Verible, sv-tests, and slang tied to local
    RTL, formal, cocotb, assertion, frontend-diagnostic, and spec hashes before
    any AI-generated verification plan, testbench, assertion, root-cause
    report, RTL patch, or verification-closure claim is allowed.
24. Use `scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id validation`
    to keep Verilator, Spike, Sail-RISC-V, riscv-formal, RISC-V compliance,
    ISA coverage, random-instruction validation, generative RISC-V fuzzing,
    FPGA-assisted CPU validation, QED/trace-debug
    methods, cross-target on-device tests, RISC-V debug/OpenOCD flows, sigrok
    and Spacely-style lab capture, boot-failure triage, FPGA bring-up, and lab
    automation tied to local QEMU/Renode, FPGA, package/board, manufacturing,
    real-world, benchmark, and release gates before any generated lab script,
    test binary, hardware action, compliance/coverage/debug claim, or silicon
    bring-up claim is allowed.
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
    profile-guided binary optimization, Autocomp/AccelOpt/V-Seek-style
    accelerator-kernel optimization, formal RISC-V semantics, and agentic
    compiler optimization tied to local compiler pins, runtime tests, RVV
    autovec checks, benchmark calibration, simulator/runtime logs,
    semantic-equivalence evidence, and review before any generated code,
    kernel, optimization memory, profile, binary, proof, or
    compiler-performance claim is allowed.
29. Use `scripts/ai_eda/capture_reliability_resilience_targets.py --run-id validation`
    to keep aging, EM, soft-error, netlist/LLVM/MLIR/QEMU/workload
    fault-injection, NPU workload resilience, and ECC/TMR mitigation work tied
    to process models, mission profiles, deterministic fault manifests, output
    classifiers, simulator/formal logs, PD/signoff evidence, before/after PPA,
    and review before any fault campaign,
    mitigation, signoff, or reliability claim is allowed.
30. Use `scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation`
    to keep HuggingFace/GitHub models and corpora in metadata-only target
    capture. Do not download weights or datasets, train, fine-tune, run
    inference, run evaluation, export local corpora, generate source, or make
    model/dataset quality claims without exact revisions, licenses, manifests,
    model-card/base-model/reward metadata where applicable, contamination
    checks, quarantine paths, deterministic local gates, and review.
31. Use `scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation`
    to keep VerilogEval, RTLLM, CVDP, ProtocolLLM, external RTL corpora, and
    contamination-detection methods behind benchmark governance. Do not import
    public benchmarks, export held-out E1 prompts, run models, run
    contamination detectors, generate RTL, or make score/model-quality claims
    without exact revisions, license review, task hashes, non-overlap reports,
    near-duplicate checks, deterministic local gates, and review.
32. Use `scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation`
    to keep MCP-style EDA wrappers, write-capable agents, commercial copilots,
    OpenROAD MCP sessions, coding-agent tool-improvement loops, and
    hardware-agent benchmarks behind command governance. Do not start MCP
    servers, call external AI APIs, invoke open-source or commercial EDA tools,
    patch OpenROAD/OpenLane, generate Tcl/shell/constraints/waivers/source, or
    make productivity, PPA, signoff, or release claims without typed command
    schemas, explicit scopes, sandbox/authentication policy, license and
    data-handling review, local replay manifests, deterministic gates, and
    review.
33. Use `scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation`
    to keep requirements-to-RTL trace matrices, complex spec-to-HLS/RTL agents,
    RTL localization, NL-to-SVA, FSM/protocol generation, and incremental
    spec-evolution assistance behind stable requirement IDs. Do not change
    specs, RTL, HLS, assertions, testbenches, or generated software contracts,
    and do not claim requirement coverage, assertion quality, localization
    quality, or traceability closure without source hashes, non-overlap review,
    vacuity checks, deterministic local gates, and review.
34. Use `scripts/ai_eda/capture_ip_register_contract_targets.py --run-id validation`
    to keep register-description languages, IP-XACT metadata, register
    generators, and IP dependency managers behind the existing E1 platform
    contract. Do not import external IP, run generators, edit memory maps,
    headers, device trees, drivers, or RTL, or claim register correctness
    without revisions, license review, generated output hashes, ABI diffs,
    deterministic local gates, and review.
35. Use `scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation`
    to keep OpenRAM, DFFRAM, SRAM22/VLSIDA Sky130 macro collateral, OpenXRAM,
    OpenRRAM, CACTI, DESTINY, NVSim, NeuroSim, OpenACM/OpenACMv2, OpenROAD
    memory macro flow references, AutoCellGen/TOPCELL/CPCell/CharLib/LibreCell/
    xcell/NVCell library flows, and OpenYield/SRAM yield/Vmin watchlists behind
    local PDK and memory evidence gates. Do not download PDKs or macros, import
    external macros, run memory compilers, CIM compilers, surrogate models,
    estimators, or standard-cell flows, edit RTL/PD/library collateral,
    generate BIST/repair collateral, or claim area, timing, power, accuracy,
    Vmin, yield, signoff, or release readiness without exact revisions,
    generated artifact hashes, DRC/LVS/extraction, characterization, STA,
    OpenLane evidence, workload replay, deterministic local gates, and review.
36. Use `scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id validation`
    to keep chiplet partitioning, 2.5D/3DIC placement/topology, UCIe/die-to-die
    standards, RapidChiplet/PlaceIT/DiffChip/TDPNavigator-style package DSE,
    LEGOSim/HISIM heterogeneous-integration simulation, MFIT/3D-ICE thermal
    simulation, package metadata exchange, cost/yield models, and LLM/agentic
    chiplet co-design work behind E1 package and architecture gates. Do not
    generate chiplet partitions, interposer layouts, package/bump maps,
    die-to-die interfaces, SI/PI/thermal models, RTL, PD configs, board/package
    edits, simulator outputs, or cost/yield/performance/signoff claims without
    exact revisions, source/license review, architecture constraints, local
    deterministic gates, and review.
37. Use `scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation`
    to keep Yosys, ABC, self-evolved ABC-style tool evolution, logic-network
    libraries, OpenABC-D/OpenLS-DGF-style datasets, and ML/RL/Bayesian
    synthesis recipe search behind local synthesis and equivalence gates. Do
    not generate or apply ABC/Yosys recipes, evolved backend patches/binaries,
    technology mappings, constraints, netlists, or gate-level rewrites, and do
    not claim area, timing, power, equivalence, signoff, or release improvement
    without exact tool/model revisions, source/script hashes, output hashes,
    formal or equivalence evidence, deterministic synthesis/STA/OpenLane/power
    gates, and review.
38. Use `scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation`
    to keep EQY, Yosys equiv_* flows, SymbiYosys/yosys-smtbmc, SMT solver
    backends, ABC CEC, CIRCT LEC, and current datapath CEC research behind
    local LEC/proof harness governance. Do not generate miters, equivalence
    scripts, waivers, proof logs, RTL, netlists, synthesis recipes, or
    optimization patches, and do not claim equivalence, timing, QoR, signoff,
    or release readiness without exact tool/solver revisions, input and output
    hashes, SMT input hashes where emitted, black-box/memory/reset/
    x-propagation/hierarchy assumptions, bounds, witnesses, counterexample
    triage, deterministic synthesis/formal/simulation/STA/OpenLane/power gates,
    and review.
39. Use `scripts/ai_eda/capture_physical_verification_targets.py --run-id validation`
    to keep KLayout DRC, Magic DRC/LVS, Netgen LVS, OpenROAD antenna checking,
    Rule2DRC/DRC-Coder-style generated deck research, AutoEDA/MCP-style
    physical-verification service boundaries, OpenDRC backend watchlist,
    structural EDA-code verification, and post-EDA repair benchmarks behind
    physical-verification governance. Do not generate or run DRC decks, layout
    repairs, LVS waivers, antenna fixes, Tcl, patches, MCP service calls,
    structural verifier approvals, OpenDRC reports, or AI signoff triage, and
    do not claim DRC, LVS, antenna, physical signoff, or release readiness
    without exact tool/server revisions, rule-deck hashes, layout/netlist
    hashes, request/response and before/after logs, deterministic extraction/
    STA/power/manufacturing/commercial-EDA gates where applicable, and review.
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
