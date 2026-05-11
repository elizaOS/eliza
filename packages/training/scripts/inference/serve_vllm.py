"""Maximally-optimized vLLM serve launcher for Milady fine-tunes.

Wraps `vllm serve` with the canonical flag set per (registry-key, GPU target)
tuple. Stack composition assembled from:

    - vLLM Recipes Qwen3.6 docs   (recipes.vllm.ai)
    - vLLM optimization guide     (docs.vllm.ai/en/stable/configuration/optimization/)
    - vLLM Speculative Decoding   (docs.vllm.ai/en/v0.10.1/features/spec_decode.html)
    - vLLM PR #38479              (turboquant_*_nc kv-cache-dtype family)
    - vLLM Expert Parallel        (docs.vllm.ai/.../expert_parallel_deployment/)
    - z-lab DFlash                (arXiv:2602.06036) — opt-in drafter, AEON-7 fork
    - Speculators v0.3.0          (blog.vllm.ai/2025/12/13/speculators-v030.html)

What this DOES NOT do:

    - Run vLLM in-process. We `exec` the `vllm serve` CLI; vLLM owns the
      worker lifecycle, NCCL groups, CUDA graphs, etc. Trying to embed
      vLLM in our own process invariably ends in NCCL-init or fork-server
      regressions when we hot-reload.
    - Port any Unsloth Triton kernels. Unsloth's "2x faster inference"
      claim is measured against unpatched HF `generate()`; vLLM bypasses
      that path entirely with PagedAttention + continuous batching +
      CUDA graphs and recovers more than that win for free.
    - Touch QJL. vLLM's KV manager rejects QJL because the JL sketch
      amplifies variance through softmax (vLLM #38171 thread). QJL stays
      on the HF MiladyHybridCache path; vLLM gets TurboQuant for both K
      and V via the merged turboquant_4bit_nc dtype. (3bit_nc is also
      available but costs ~20pp on GSM8K vs ~3% PPL for 4bit_nc; we
      default to 4-bit. See /tmp/turboquant_v_reconcile.md.)

Usage:
    # eliza-1-2b on a single GPU (workstation tier, debugging / local serving)
    uv run --extra serve python scripts/inference/serve_vllm.py \\
        --registry-key qwen3.5-2b --port 8000

    # eliza-1-9b on workstation H100, EAGLE-3 drafter
    uv run --extra serve python scripts/inference/serve_vllm.py \\
        --registry-key qwen3.5-9b \\
        --eagle3 RedHatAI/Qwen3.5-9B-EAGLE3-head \\
        --port 8000

    # eliza-1-27b on 2x H200, DFlash drafter (AEON-7 fork required)
    MILADY_VLLM_DFLASH=1 \\
    uv run --extra serve python scripts/inference/serve_vllm.py \\
        --registry-key qwen3.6-27b \\
        --dflash z-lab/Qwen3.6-27B-DFlash \\
        --port 8000

    # Print the assembled command without executing (audit / CI)
    uv run --extra serve python scripts/inference/serve_vllm.py \\
        --registry-key qwen3.6-27b --dry-run

The MoE expert-parallel + qwen3_next_mtp + --language-model-only branches
are kept intact for forward compatibility with future MoE entries (gated on
``extra['moe_active_b']`` in the registry); they're inert for the current
dense-only eliza-1 lineup.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from training.model_registry import get as registry_get  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("serve_vllm")


# Per-GPU target: (vLLM tensor_parallel_size, gpu_memory_utilization,
# weight_quantization_default, kv_cache_dtype_default, attention_backend).
# Hopper (sm_90) gets FP8 + TurboQuant + FA3. Blackwell consumer (sm_120) is
# a flag-by-flag downgrade because FA3, TE FP8 recipes, and the merged
# TurboQuant kernel currently lack sm_120 builds in mainline vLLM as of
# v0.20.1 — pin AEON-7's vllm-dflash fork (`vllm-dflash`) for the full stack.
GPU_TARGETS: dict[str, dict] = {
    "h200-2x": {
        "tp": 2,
        "ep": 2,                                  # MoE-only; ignored for dense
        "gpu_memory_utilization": 0.92,
        "default_weight_quant": "fp8",            # block-wise FP8 W8A8 on Hopper
        # turboquant_4bit_nc, not 3bit. Per PR #38479 numbers (Qwen3-4B):
        # 3bit_nc costs ~20pp absolute on GSM8K and +20.59% PPL; 4bit_nc costs
        # only +2.71% PPL. 4bit also matches our vendored fused_turboquant V
        # bit-width (4-bit RHT+Lloyd-Max), so served-vs-local-debug parity is
        # closer. See /tmp/turboquant_v_reconcile.md.
        "default_kv_cache_dtype": "turboquant_4bit_nc",
        "attention_backend": None,                # let vLLM pick (FA3 on sm_90)
    },
    "h100-2x": {
        "tp": 2, "ep": 2, "gpu_memory_utilization": 0.92,
        "default_weight_quant": "fp8",
        "default_kv_cache_dtype": "turboquant_4bit_nc",
        "attention_backend": None,
    },
    "h200-4x": {
        "tp": 4, "ep": 4, "gpu_memory_utilization": 0.92,
        "default_weight_quant": "fp8",
        "default_kv_cache_dtype": "turboquant_4bit_nc",
        "attention_backend": None,
    },
    "blkw6000-2x": {
        "tp": 2, "ep": 2, "gpu_memory_utilization": 0.90,
        # FP8 wheels for sm_120 are spotty; AWQ-Marlin works everywhere.
        "default_weight_quant": "awq_marlin",
        # Mainline vLLM TurboQuant kernels currently lack sm_120 builds;
        # AEON-7 vllm-dflash carries the patched build. fp8_e4m3 is the
        # safe fallback on stock vLLM.
        "default_kv_cache_dtype": "fp8_e4m3",
        "attention_backend": None,
    },
    "blkw6000-4x": {
        "tp": 4, "ep": 4, "gpu_memory_utilization": 0.90,
        "default_weight_quant": "awq_marlin",
        "default_kv_cache_dtype": "fp8_e4m3",
        "attention_backend": None,
    },
    "b200-2x": {
        "tp": 2, "ep": 2, "gpu_memory_utilization": 0.93,
        "default_weight_quant": "fp8",
        "default_kv_cache_dtype": "turboquant_4bit_nc",
        "attention_backend": None,
    },
    "single": {                                   # local debug, anything 1-GPU
        "tp": 1, "ep": 1, "gpu_memory_utilization": 0.85,
        "default_weight_quant": None,
        "default_kv_cache_dtype": None,
        "attention_backend": None,
    },
}


def _detect_default_target() -> str:
    """Best-effort guess for the GPU target so the user gets sensible
    defaults without having to remember the cluster shape.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return "single"
        n = torch.cuda.device_count()
        cap = torch.cuda.get_device_capability(0)
        # sm_90 = H100/H200, sm_100 = B200, sm_120 = consumer Blackwell.
        if cap == (9, 0):
            return "h200-2x" if n >= 2 else "single"
        if cap == (10, 0):
            return "b200-2x" if n >= 2 else "single"
        if cap == (12, 0):
            if n >= 4:
                return "blkw6000-4x"
            if n >= 2:
                return "blkw6000-2x"
            return "single"
    except Exception:  # noqa: BLE001
        pass
    return "single"


def _is_moe(entry) -> bool:
    """Registry entries set extra['moe_active_b'] for MoE models."""
    return "moe_active_b" in entry.extra


def _build_speculative_config(
    *, eagle3_path: str | None, dflash_path: str | None,
    mtp_native: bool, num_speculative_tokens: int,
) -> dict | None:
    """Pick exactly one drafter. They are mutually exclusive at runtime.

    Priority (highest first):
      1. Explicit --dflash (requires MILADY_VLLM_DFLASH=1 + vllm-dflash fork)
      2. Explicit --eagle3 (works on stock vLLM; needs a per-model EAGLE3 head)
      3. Implicit qwen3_next_mtp on MoE models that ship an MTP head
    """
    if dflash_path:
        if os.environ.get("MILADY_VLLM_DFLASH") not in ("1", "true", "yes"):
            log.warning(
                "--dflash specified without MILADY_VLLM_DFLASH=1 — DFlash "
                "requires the AEON-7 vllm-dflash fork (vLLM PR #40898 unmerged). "
                "Set MILADY_VLLM_DFLASH=1 to confirm the fork is installed; "
                "otherwise vLLM will fail with 'unknown speculative method'."
            )
        return {
            "method": "dflash",
            "model": dflash_path,
            "num_speculative_tokens": num_speculative_tokens or 15,
        }
    if eagle3_path:
        return {
            "method": "eagle3",
            "model": eagle3_path,
            "num_speculative_tokens": num_speculative_tokens or 3,
            "draft_tensor_parallel_size": 1,    # EAGLE-3 cannot TP
        }
    if mtp_native:
        return {
            "method": "qwen3_next_mtp",
            "num_speculative_tokens": num_speculative_tokens or 2,
        }
    return None


_HYBRID_QWEN_PREFIXES = ("Qwen/Qwen3.5", "Qwen/Qwen3.6", "elizalabs/eliza-1")


def _is_hybrid_qwen(model_id: str) -> bool:
    """All Qwen3.5/3.6 ship the 3-GDN-:-1-GA hybrid attention pattern, and our
    eliza-1 series is a fine-tune of those bases. omlx#825 is gated to this
    arch family."""
    return any(model_id.startswith(p) for p in _HYBRID_QWEN_PREFIXES)


def build_command(args, *, entry) -> list[str]:
    """Assemble the canonical `vllm serve` argv list for the given args."""
    target = GPU_TARGETS[args.gpu_target]
    is_moe = _is_moe(entry)

    model_id = args.model or entry.hf_id
    weight_quant = args.quantization or target["default_weight_quant"]
    kv_dtype = args.kv_cache_dtype or target["default_kv_cache_dtype"]
    max_model_len = args.max_model_len or (entry.infer_max_in + entry.infer_max_out)

    # Safety gate against omlx#825: DFlash drafter + APC + Qwen3.5/3.6 hybrid
    # attention is a known failure surface (linear-attn conv_state/ssm_state
    # don't replay correctly on prefix-cache hits, breaks tool calling). If
    # all three are set without an explicit acknowledgement that A/B parity
    # has been verified for this serve, default APC OFF.
    drafter_active = bool(args.dflash) or bool(args.eagle3) or (is_moe and args.use_mtp_native)
    if (
        args.enable_prefix_caching
        and drafter_active
        and _is_hybrid_qwen(model_id)
        and os.environ.get("MILADY_APC_DRAFTER_VERIFIED") not in ("1", "true", "yes")
    ):
        log.warning(
            "APC + drafter on a Qwen3.5/3.6 hybrid model is gated by "
            "omlx#825 — disabling --enable-prefix-caching for this serve. "
            "Run scripts/inference/test_apc_dflash_tool_calls.py against "
            "this build, then set MILADY_APC_DRAFTER_VERIFIED=1 to re-enable."
        )
        args.enable_prefix_caching = False

    cmd: list[str] = [
        "vllm", "serve", model_id,
        "--tensor-parallel-size", str(target["tp"]),
        "--max-model-len", str(max_model_len),
        "--gpu-memory-utilization", f"{target['gpu_memory_utilization']:.2f}",
        "--dtype", "bfloat16",
    ]

    if weight_quant:
        cmd += ["--quantization", weight_quant]
    if kv_dtype:
        cmd += ["--kv-cache-dtype", kv_dtype]
        # --calculate-kv-scales rules:
        #   * turboquant_*  - NEVER add. Scales are deterministic per-block
        #                     (amax/1.51), no calibration needed.
        #   * fp8_*         - add ONLY for non-hybrid attention models.
        #                     vllm#37554: --calculate-kv-scales on hybrid
        #                     attention + recurrent (Qwen3.5/3.6 GDN) breaks
        #                     under prefix caching because the recurrent
        #                     state isn't profiled the same way.
        if (
            "fp8" in kv_dtype
            and "turboquant" not in kv_dtype
            and not _is_hybrid_qwen(model_id)
        ):
            cmd += ["--calculate-kv-scales"]

    # Prefix caching + chunked prefill — V1 defaults plus tunings from the
    # vLLM optimization page. Block size 16 is the sweet spot for chat-style
    # workloads (8 fragments cache too aggressively, 32 reduces hit rate).
    #
    # APC + turboquant_{3,4}bit_nc is SAFE because:
    #   1. vLLM APC hashes only (parent_hash, token_ids, extra_keys) — see
    #      vllm/v1/core/kv_cache_utils.py::hash_block_tokens (v0.20.1, L398-427).
    #      No KV bytes, no kv_cache_dtype, no scales enter the hash.
    #   2. TurboQuant quantization is fully deterministic on input bytes:
    #      fixed Walsh-Hadamard rotation (no seed), fixed codebook centroids
    #      {±0.453, ±1.51}, per-block scale = amax/1.51 (pure function of
    #      input). Upstream confirms "zero calibration" + "token-for-token
    #      identical to FP16 at T=0".
    #   3. Therefore identical prefixes -> identical post-quant blocks ->
    #      cache reuse across requests is byte-correct.
    # If we ever switch to a kv-cache-dtype that uses runtime / per-batch
    # calibration scales, REVISIT — APC will silently merge cache lines that
    # have different decode-time scales. Specifically, do NOT combine
    # --enable-prefix-caching with --calculate-kv-scales on hybrid attention
    # + recurrent models (vllm#37554) on FP8.
    if args.enable_prefix_caching:
        cmd += [
            "--enable-prefix-caching",
            "--block-size", str(args.prefix_block_size),
        ]
    cmd += [
        "--enable-chunked-prefill",
        "--max-num-batched-tokens", str(args.max_num_batched_tokens),
        "--long-prefill-token-threshold", str(args.long_prefill_token_threshold),
    ]

    # CUDA graphs — never --enforce-eager on production. Unsloth's published
    # recommendation to use --enforce-eager is a 15-30% decode regression.
    cmd += [
        "--compilation-config",
        json.dumps(
            {
                "cudagraph_mode": args.cudagraph_mode,
                "level": args.compilation_level,
            },
            separators=(",", ":"),
        ),
    ]

    # Expert parallel + EPLB for MoE. EPLB redistributes tokens across hot
    # experts; --num-redundant-experts replicates them to flatten imbalance.
    if is_moe:
        cmd += [
            "--enable-expert-parallel",
            "--enable-eplb",
            "--num-redundant-experts", str(args.num_redundant_experts),
        ]
        if args.language_model_only:
            # A3B HF class is multimodal; this skips the vision encoder for
            # text-only deploys and reclaims its KV budget.
            cmd += ["--language-model-only"]

    # Speculative decoder. Mutually exclusive — pick one.
    spec_cfg = _build_speculative_config(
        eagle3_path=args.eagle3,
        dflash_path=args.dflash,
        mtp_native=is_moe and args.use_mtp_native,
        num_speculative_tokens=args.num_speculative_tokens,
    )
    if spec_cfg is not None:
        cmd += ["--speculative-config", json.dumps(spec_cfg, separators=(",", ":"))]

    # Reasoning + tool-call parsers for Qwen3 chat-template streams.
    if args.reasoning_parser:
        cmd += ["--reasoning-parser", args.reasoning_parser]
    if args.enable_tool_choice:
        cmd += [
            "--enable-auto-tool-choice",
            "--tool-call-parser", args.tool_call_parser,
        ]

    # Attention backend override (mostly for AEON-7 vllm-dflash which exposes
    # FUSED_TURBOQUANT as our vendored package's plugin).
    if target["attention_backend"]:
        cmd += ["--attention-backend", target["attention_backend"]]
    if args.attention_backend:
        cmd += ["--attention-backend", args.attention_backend]

    cmd += ["--port", str(args.port)]
    if args.host:
        cmd += ["--host", args.host]
    if args.served_model_name:
        cmd += ["--served-model-name", args.served_model_name]

    if args.extra:
        cmd += shlex.split(args.extra)

    return cmd


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.split("\n\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--registry-key", required=True,
                    help="Pull defaults from training/model_registry.py "
                         "(e.g. qwen3.5-2b, qwen3.5-9b, qwen3.6-27b).")
    ap.add_argument("--model", default=None,
                    help="Override model id (default: registry hf_id).")
    ap.add_argument("--gpu-target", default=_detect_default_target(),
                    choices=sorted(GPU_TARGETS),
                    help="Per-cluster defaults; auto-detected from CUDA caps.")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default=None)
    ap.add_argument("--served-model-name", default=None)
    ap.add_argument("--max-model-len", type=int, default=None,
                    help="Default: registry infer_max_in + infer_max_out.")

    # Quantization knobs — defaults come from gpu_target.
    ap.add_argument("--quantization", default=None,
                    help="vLLM weight quant: fp8, awq_marlin, gptq_marlin, "
                         "polarquant (custom plugin), gguf. Default per "
                         "gpu_target: fp8 on H100/H200, awq_marlin on Blackwell.")
    ap.add_argument("--kv-cache-dtype", default=None,
                    help="auto, fp8, fp8_e4m3, fp8_e5m2, turboquant_3bit_nc, "
                         "turboquant_4bit_nc, turboquant_k8v4, turboquant_k3v4_nc. "
                         "Default per gpu_target: turboquant_4bit_nc on "
                         "Hopper/Blackwell datacenter (best PPL/throughput "
                         "trade vs 3bit_nc — see PR #38479 numbers), fp8_e4m3 "
                         "on consumer Blackwell.")
    ap.add_argument("--attention-backend", default=None,
                    help="FUSED_TURBOQUANT (our vendored plugin), FLASH_ATTN, "
                         "FLASHINFER, etc. Default: vLLM auto.")

    # Prefix cache + chunked prefill — see vLLM optimization docs.
    ap.add_argument("--enable-prefix-caching", action=argparse.BooleanOptionalAction,
                    default=True,
                    help="Hash 16-token blocks of the prefix; reuse across "
                         "requests. Caveat: known omlx#825 bug — prefix-cache + "
                         "Qwen3.5/3.6 hybrid attention + drafter can break tool "
                         "calling on cache hits. A/B test before enabling on "
                         "production agent traffic.")
    ap.add_argument("--prefix-block-size", type=int, default=16,
                    help="APC block size. 16 is the chat sweet spot.")
    ap.add_argument("--max-num-batched-tokens", type=int, default=8192,
                    help="vLLM optimization sweet spot for online serving.")
    ap.add_argument("--long-prefill-token-threshold", type=int, default=2048,
                    help="Switch to chunked-prefill above this prompt length.")

    # CUDA graph + compilation policy.
    ap.add_argument("--cudagraph-mode", default="FULL_AND_PIECEWISE",
                    choices=("FULL", "FULL_AND_PIECEWISE", "PIECEWISE", "NONE"),
                    help="Default FULL_AND_PIECEWISE — uniform decode + "
                         "piecewise prefill. Never use NONE / --enforce-eager "
                         "on production; that's a 15-30%% decode regression.")
    ap.add_argument("--compilation-level", type=int, default=3,
                    help="vLLM Inductor optimization level. -O3 adds extra "
                         "fusions on top of the -O2 default.")

    # Speculative decoder. Mutually exclusive — pick at most one.
    ap.add_argument("--eagle3", default=None,
                    help="HF id or local path to a Qwen3.6-EAGLE3 head. "
                         "Stock vLLM, ~2x decode speedup. Mutually exclusive "
                         "with --dflash and --use-mtp-native.")
    ap.add_argument("--dflash", default=None,
                    help="HF id or local path to a z-lab/...-DFlash drafter. "
                         "Requires the AEON-7 vllm-dflash fork "
                         "(set MILADY_VLLM_DFLASH=1 to acknowledge). 2.5-6x "
                         "decode on greedy code/math; ~2.75x on prose.")
    ap.add_argument("--use-mtp-native", action=argparse.BooleanOptionalAction,
                    default=True,
                    help="On MoE models that ship an MTP head, use "
                         "method=qwen3_next_mtp by default. Disable to opt "
                         "out (e.g. when the MTP head is broken on your "
                         "vLLM build).")
    ap.add_argument("--num-speculative-tokens", type=int, default=0,
                    help="0 = method-specific default (15 dflash, 3 eagle3, 2 mtp).")
    ap.add_argument("--entropix", action="store_true",
                    help="Enable entropix logits-processor plugin. NOT compatible with "
                         "EAGLE-3/DFlash drafter (drafter cannot predict the forced-clarifier "
                         "branch; spec-decode acceptance collapses). Hard error if combined.")

    # MoE-specific.
    ap.add_argument("--num-redundant-experts", type=int, default=8,
                    help="EPLB redundancy. Drop to 0 if VRAM-bound.")
    ap.add_argument("--language-model-only", action=argparse.BooleanOptionalAction,
                    default=True,
                    help="Skip the multimodal vision encoder branch on A3B-class "
                         "models for text-only serving (frees its KV budget).")

    # Tool / reasoning parsers — Qwen3-canonical.
    ap.add_argument("--reasoning-parser", default="qwen3")
    ap.add_argument("--enable-tool-choice", action=argparse.BooleanOptionalAction,
                    default=True)
    ap.add_argument("--tool-call-parser", default="qwen3_coder")

    ap.add_argument("--extra", default="",
                    help="Extra raw flags appended to the vllm serve command "
                         "(use shlex-style quoting).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the assembled command and exit without running.")
    ap.add_argument("--with-heartbeat", action="store_true",
                    help="Also spawn scripts.inference.heartbeat as a child "
                         "subprocess so this serve emits periodic stats to "
                         "--stats-out. Killed on serve teardown.")
    ap.add_argument("--stats-out", default="~/.milady/inference-stats.jsonl",
                    help="JSONL path the heartbeat appends to (only used "
                         "when --with-heartbeat is set).")
    args = ap.parse_args()

    if sum(bool(x) for x in (args.eagle3, args.dflash)) > 1:
        ap.error("--eagle3 and --dflash are mutually exclusive — pick one.")

    entry = registry_get(args.registry_key)
    if args.entropix and (
        args.eagle3 or args.dflash or (_is_moe(entry) and args.use_mtp_native)
    ):
        ap.error("--entropix is incompatible with --eagle3/--dflash/--use-mtp-native: "
                 "entropix's HELV branch flips the argmax, and EAGLE-3/DFlash drafters "
                 "cannot predict that, so spec-decode acceptance collapses to ~1/K. "
                 "Drop the drafter or drop --entropix.")
    log.info("registry %s → hf_id=%s tier=%s",
             entry.short_name, entry.hf_id, entry.tier.value)
    log.info("gpu target=%s tp=%d", args.gpu_target,
             GPU_TARGETS[args.gpu_target]["tp"])

    cmd = build_command(args, entry=entry)
    if args.entropix:
        cmd += ["--logits-processors",
                "scripts.inference.entropix_sampler:VLLMEntropixProcessor"]
    pretty = " \\\n  ".join(shlex.quote(c) for c in cmd)
    log.info("assembled vllm command:\n  %s", pretty)

    if args.dry_run:
        return 0
    if shutil.which(cmd[0]) is None:
        log.error("`vllm` not on PATH — install with: uv add --extra serve vllm")
        return 1
    if not args.with_heartbeat:
        return subprocess.call(cmd)
    return _run_with_heartbeat(cmd, port=args.port, stats_out=args.stats_out)


def _heartbeat_metrics_url(serve_cmd: list[str], port: int) -> str:
    # vLLM exposes /metrics on the same OpenAI server port. Honour --host
    # if the operator pinned one (e.g. 127.0.0.1 in cloud onstart).
    host = "127.0.0.1"
    if "--host" in serve_cmd:
        idx = serve_cmd.index("--host")
        if idx + 1 < len(serve_cmd):
            host = serve_cmd[idx + 1]
    return f"http://{host}:{port}/metrics"


def _run_with_heartbeat(serve_cmd: list[str], *, port: int, stats_out: str) -> int:
    """Spawn vllm + heartbeat and forward signals to both."""
    metrics_url = _heartbeat_metrics_url(serve_cmd, port)
    label = f"serve-vllm-port-{port}"
    hb_cmd = [
        sys.executable, "-m", "scripts.inference.heartbeat",
        "--vllm-metrics-url", metrics_url,
        "--out", stats_out,
        "--label", label,
    ]

    log.info("launching vllm: %s", " ".join(shlex.quote(c) for c in serve_cmd))
    serve_proc = subprocess.Popen(serve_cmd)
    log.info("launching heartbeat: %s", " ".join(shlex.quote(c) for c in hb_cmd))
    # cwd=training/ so `python -m scripts.inference.heartbeat` resolves.
    hb_cwd = str(Path(__file__).resolve().parent.parent.parent)
    try:
        hb_proc = subprocess.Popen(hb_cmd, cwd=hb_cwd)
    except OSError as exc:
        log.error("failed to launch heartbeat (%s); continuing without it", exc)
        hb_proc = None

    def _shutdown(signum: int, _frame) -> None:
        log.info("received signal %d — tearing down", signum)
        if hb_proc is not None and hb_proc.poll() is None:
            hb_proc.terminate()
        if serve_proc.poll() is None:
            serve_proc.send_signal(signum)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        rc = serve_proc.wait()
    finally:
        if hb_proc is not None and hb_proc.poll() is None:
            hb_proc.terminate()
            try:
                hb_proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                hb_proc.kill()
    return rc


if __name__ == "__main__":
    sys.exit(main())
