# Mobile runtime landscape (2026-05-19)

Research summary of the on-device runtime surface E1 will eventually plug
into. Nothing here certifies E1 implementation status; the existing E1
runtime is a Python harness at `packages/chip/compiler/runtime/`.

## 1. TFLite → LiteRT under Google AI Edge

Google rebranded TensorFlow Lite as **LiteRT** under the **Google AI Edge**
umbrella. The runtime, file format, and delegate model are the same lineage
as TFLite:

- `litert::Interpreter` (formerly `tflite::Interpreter`) executes a flatbuffer
  model.
- Delegates plug in per-op via `ModifyGraphWithDelegate`; the modern path is
  the **NNAPI delegate is deprecated** and replaced by per-SoC delegates
  (Qualcomm QNN, MediaTek NeuroPilot, Samsung ENN) or by ExecuTorch
  interoperability for PyTorch models.
- Quantization is INT8 dynamic / INT8 static / INT16 / **INT4 weight-only**
  via `tflite.TFLiteConverter` with experimental flags, and increasingly via
  the new **AI Edge Torch** path that goes
  PyTorch → `torch.export` → StableHLO (via `odml-torch`) → LiteRT flatbuffer.
- LiteRT supports **StableHLO ingestion** directly, which is the canonical
  way new models reach the runtime in 2026.

For E1 the LiteRT integration point is a **TFLite delegate**, but a fresh
delegate written today would also need to handle the AI Edge Torch / StableHLO
ingestion path because that is where new mobile models live.

## 2. NNAPI deprecation and Android AICore / AI Edge

Android NNAPI (Neural Networks API) is **deprecated** as of Android 15. The
deprecation guide directs Android app developers to:

- Use **TFLite/LiteRT** with per-SoC delegates instead of NNAPI directly.
- For PyTorch models, use **ExecuTorch** with per-SoC delegates.
- For first-party Google features, use **Android AICore** (a system service
  hosting Gemini Nano and similar foundation models).

There is no public 1:1 NNAPI successor API for third-party developers. The
practical mobile NN abstractions for new chips in 2026 are:

1. **TFLite/LiteRT delegate** — works for any TFLite/LiteRT consumer.
2. **ExecuTorch delegate** — works for PyTorch consumers and is the
   forward direction for new Android system features.
3. **ONNX Runtime EP** — works for ONNX consumers and Windows-on-ARM.
4. **Vendor SDK** — direct path (QNN, NeuroPilot, Core ML, etc.) for
   first-party apps.

An Android NPU integration story that lists all three of (1) (2) (3) plus a
direct SDK is what current flagship NPUs deliver. The `docs/spec-db/npu-2028-target.yaml`
software target already reflects this expectation.

## 3. ExecuTorch — the PyTorch on-device runtime

ExecuTorch is the official PyTorch on-device runtime. Its architecture:

- A model is captured by `torch.export` into an `ExportedProgram`.
- A **partitioner** annotates which subgraphs belong to which backend.
- Each backend's `preprocess(edge_program) -> bytes` converts the
  partitioned subgraph into a backend-specific compiled blob.
- The resulting `.pte` file is loaded by the ExecuTorch runtime, which
  invokes registered backends per delegated subgraph.

Current public backends (as of mid-2026):

- **XNNPACK** (CPU, INT8) — baseline.
- **KleidiAI** (Arm hand-tuned INT8 / INT4 micro-kernels) — also CPU.
- **CoreML / MPS** — Apple Silicon (ANE + Metal).
- **Vulkan** — generic mobile GPU.
- **Qualcomm QNN** — Hexagon NPU.
- **MediaTek NeuroPilot** — Dimensity NPU.
- **Samsung Exynos** — partial.
- **Cadence HiFi / Xtensa** — DSP.

An E1 ExecuTorch backend would slot at this level. The minimal API surface
is `Partitioner`, `preprocess`, and a runtime `BackendInterface` with
`init` / `execute` / `destroy`. The compiled bytes are opaque to the
runtime, so the entire E1 compiler output can be packed there.

## 4. ONNX Runtime Mobile / Web — Execution Provider model

ONNX Runtime (`github.com/microsoft/onnxruntime`) is Microsoft's runtime,
widely used for Windows-on-ARM, Office, Edge, and cross-platform mobile.
Its plug-in model is the **Execution Provider** (EP):

- An EP registers per-op kernels and a partitioning function that decides
  which subgraph the EP can handle.
- Quantization in ORT is QDQ-graph based: `QuantizeLinear` /
  `DequantizeLinear` nodes surround quantized ops, and EPs match the
  pattern.
- Existing EPs include CUDA, TensorRT, DirectML, OpenVINO, ROCm, CoreML,
  NNAPI (legacy), **QNN** (Hexagon NPU), and CPU.

An E1 ONNX Runtime EP is the natural way to absorb ONNX-formatted models,
which still dominate Windows and many enterprise pipelines.

## 5. Apple MLX, MediaPipe, vLLM, SGLang, MAX

These are not target runtimes for E1 directly but are relevant references:

- **MLX** (`ml-explore/mlx`) — Apple Silicon array framework with unified
  memory and lazy graph compilation. Useful reference for unified-memory NPU
  integration in a future SoC.
- **MediaPipe** (`google-ai-edge/mediapipe`) — graph-of-tasks runtime above
  LiteRT, with the public **LLM Inference API**. Relevant for showing what
  the runtime layer above LiteRT looks like.
- **vLLM** (`vllm-project/vllm`) — server-side LLM inference with
  PagedAttention. Source of the KV-cache layout conventions every modern
  LLM kernel follows.
- **SGLang** — structured generation runtime with RadixAttention for prefix
  sharing.
- **MAX** (Modular) — Mojo-backed serving runtime; alternative architecture.
- **llama.cpp / GGUF** — de facto on-device LLM CPU runtime with INT4/INT5/INT8
  weights. The **GGUF** file format is now adopted across many quantization
  toolkits and is the realistic INT4 weight format for community models.

## 6. Vendor mobile NN SDKs

The vendor SDKs an E1-class NPU competes against in 2026:

- **Qualcomm QNN / AI Engine Direct** — Hexagon-specific SDK with direct
  delegates for TFLite, ExecuTorch, ORT.
- **Apple Core ML / MIL IR** — `.mlpackage`, MIL intermediate representation,
  ANE backend.
- **MediaTek NeuroPilot / Genio** — TFLite + ExecuTorch delegates, NPU SDK.
- **Samsung ENN** — Exynos NN SDK with TFLite delegate.
- **AIMET** (Qualcomm AI Model Efficiency Toolkit) — the public PTQ/QAT
  toolkit Qualcomm itself uses to prepare models for QNN.

The bar for "an NPU you can ship on an Android flagship in 2028" includes
at least: a TFLite/LiteRT delegate, an ExecuTorch backend, an ONNX Runtime
EP, an INT8/INT4 quantization toolkit (own or AIMET-derived), and an AIDL
HAL + VTS/CTS surface inside Android. `docs/spec-db/npu-2028-target.yaml`
already encodes this.

## 7. What this means for E1

The realistic mobile-runtime story for E1, in order of typical effort:

1. **LiteRT delegate** — first frontier. Smallest viable integration; lets
   E1 absorb the largest existing model corpus (TFLite + AI Edge Torch).
2. **ExecuTorch backend** — required to absorb PyTorch models without an
   explicit conversion step. Same compiler internals can serve both.
3. **ONNX Runtime EP** — required for Windows-on-ARM and enterprise ONNX
   pipelines.
4. **AIDL NN HAL + Android system integration** — required for
   first-party Android features and VTS/CTS gates.
5. **Direct C/C++ SDK** — required so app developers can bypass the framework
   layer when they need to. Equivalent of QNN's direct API.

The compiler internals across (1) (2) (3) can be shared if the entry IR is
StableHLO (or linalg-on-tensors via MLIR). The runtime ABI is per-framework
but thin. The E1 software gates in `docs/spec-db/npu-2028-target.yaml`
already list MLIR/StableHLO, TFLite delegate, ExecuTorch, IREE/TVM, MLPerf
Mobile, AIDL HAL, and SELinux fail-closed; this analysis confirms those
are the right surfaces.
