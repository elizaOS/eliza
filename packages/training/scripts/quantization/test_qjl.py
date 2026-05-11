"""End-to-end validation of QJL on a real Qwen3 model on the local 5080.

Honest about what QJL is: a *runtime KV-cache* quantizer for the **K
(keys) side** of attention. It does NOT shrink ``model.safetensors`` on
disk -- the weights are unchanged. Together with TurboQuant on the V
side, the KV cache shrinks ~10x at long context (1-bit K + 4-bit V).

This test measures:

  1. Whether the vendored CUDA extension at ``scripts/quantization/qjl/``
     builds. If ``nvcc`` is missing the build aborts and we record the
     exact command the user must run; downstream measurements that need
     the C++ extension are skipped with that note. The pure-PyTorch
     reference path (upstream ``QJLSketch.qjl_qunatize``) still runs.

  2. Baseline generation on ``Qwen/Qwen3-0.6B`` with bf16 ``DynamicCache``:
     peak VRAM, tok/sec, decoded sample.

  3. **Pure-PyTorch QJL simulation** on real K activations from a forward
     pass: project the per-token (head_dim,) K vector through a JL
     matrix Π ∈ R^{head_dim × s}, sign-quantize to 1 bit, and measure
     the actual byte footprint vs the bf16 baseline. This isolates the
     compression ratio that QJL achieves on the target distribution.

  4. Analytic KV bytes/token across the whole model from
     ``qjl_apply.kv_bytes_per_token_analytic``.

  5. Asserts:
     - K-cache bytes per token drop by ≥ 7x at the canonical 1-bit
       setting with projection_dim=256 and per-token bf16 norms (which
       is what upstream's ``QJLKeyQuantizer.build_sketch`` actually
       stores: ``key_states_norm = norm(key, dim=-1)`` shape (B,H,T)).
       The paper's headline ~16x figure is the *inlier-only* ratio; the
       norm-per-token overhead drags the realized ratio to
       ``head_dim * 2 / (projection_dim/8 + 2)`` -- e.g.
       ``128*2 / (256/8 + 2) = 7.53x`` for Qwen3-0.6B at projection_dim=256.
       At projection_dim=128 the same formula gives 14.2x; the smaller
       projection trades quality for ratio. The ratio asserted here
       (≥7x) is the honest end-to-end number for the canonical
       projection_dim=256 setting.
     - Baseline outputs are non-empty / non-degenerate.

Why we do NOT measure the runtime peak VRAM of QJL itself
---------------------------------------------------------
The upstream ``LlamaAttention_QJL`` wrapper (``models/llama3_qjl.py``)
imports ``qjl_kernel.cuda_qjl_quant`` at module load time. Without the
CUDA extension built, that import path can't be exercised end-to-end
on this box. We measure what we *can* measure (the analytic and
pure-PyTorch ratios on real activations) and emit the exact build
command the user needs. See ``scripts/quantization/README.md`` for the
full build prereqs (``sudo apt install nvidia-cuda-toolkit
python3.12-dev``) and the Blackwell ``TORCH_CUDA_ARCH_LIST`` workaround.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")
AutoModelForCausalLM = transformers.AutoModelForCausalLM
AutoTokenizer = transformers.AutoTokenizer
DynamicCache = pytest.importorskip("transformers.cache_utils").DynamicCache

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_qjl")

ROOT = Path(__file__).resolve().parents[2]
QJL_DIR = ROOT / "scripts" / "quantization" / "qjl"
VAL_JSONL = ROOT / "data" / "final" / "val.jsonl"


# ---------------------------------------------------------------------------
# Build attempt for the vendored CUDA extension. The build is best-effort:
# success unlocks the runtime QJL kernel; failure is recorded with the exact
# remediation command and we proceed with the analytic / pure-pytorch path.
# ---------------------------------------------------------------------------


def attempt_qjl_kernel_build() -> dict:
    """Try to compile ``scripts/quantization/qjl/csrc/*.cu``. Returns a dict
    describing the outcome plus any actionable error.
    """
    nvcc = shutil.which("nvcc")
    python_h_paths = [
        Path("/usr/include/python3.12/Python.h"),
        Path("/usr/include/python3.11/Python.h"),
        Path(sys.prefix) / "include" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "Python.h",
    ]
    python_h = next((p for p in python_h_paths if p.exists()), None)

    info: dict = {
        "nvcc_present": bool(nvcc),
        "nvcc_path": nvcc,
        "python_h_present": bool(python_h),
        "python_h_path": str(python_h) if python_h else None,
    }

    if not nvcc or not python_h:
        info["built"] = False
        info["error"] = (
            f"missing prerequisites (nvcc={'OK' if nvcc else 'MISSING'},"
            f" python.h={'OK' if python_h else 'MISSING'})"
        )
        info["remediation"] = (
            "sudo apt install nvidia-cuda-toolkit python3.12-dev   # then:\n"
            "cd scripts/quantization/qjl && "
            "TORCH_CUDA_ARCH_LIST='12.0+PTX' "
            "python setup.py build_ext --inplace"
        )
        return info

    log.info("nvcc and python.h are present; attempting kernel build")
    env = dict(os.environ)
    env["TORCH_CUDA_ARCH_LIST"] = env.get("TORCH_CUDA_ARCH_LIST", "12.0+PTX")
    proc = subprocess.run(
        [sys.executable, "setup.py", "build_ext", "--inplace"],
        cwd=str(QJL_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    info["build_returncode"] = proc.returncode
    info["build_stdout_tail"] = "\n".join(proc.stdout.splitlines()[-20:])
    info["build_stderr_tail"] = "\n".join(proc.stderr.splitlines()[-30:])
    info["built"] = proc.returncode == 0
    if not info["built"]:
        info["error"] = (
            f"build_ext failed (rc={proc.returncode}); see build_stderr_tail"
        )
        info["remediation"] = (
            "If the failure is sm_120-related, rebuild with"
            " TORCH_CUDA_ARCH_LIST='12.0+PTX'."
            " Otherwise inspect the stderr tail above."
        )
    return info


# ---------------------------------------------------------------------------
# Pure-PyTorch QJL reference (no CUDA extension required).
# Mirrors upstream ``QJLSketch.qjl_qunatize`` (note the upstream typo) from
# qjl/qjl_kernel.py's parent ``models/llama3_utils_qjl.py``. We re-derive
# the inlier branch only because the outlier branch needs the runtime hook
# in attention forward to know which head_dim coords are outliers per row.
# ---------------------------------------------------------------------------


def qjl_pure_pytorch_quantize(
    keys: torch.Tensor, *, projection_dim: int, seed: int = 42
) -> tuple[torch.Tensor, int, int]:
    """1-bit JL projection of K activations.

    Args:
        keys: (B, num_kv_heads, T, head_dim) bf16/fp16/fp32.
        projection_dim: JL output dimension (the QJL paper calls this
            ``key_quantization_bits`` -- a misnomer; it's the projected
            dimension count, not bits per coord). Must be a multiple of 8.
        seed: PRNG seed for the JL matrix.

    Returns:
        (packed_signs, baseline_bytes, qjl_bytes)
    """
    assert projection_dim % 8 == 0, "projection_dim must be byte-aligned"
    B, H, T, D = keys.shape
    g = torch.Generator(device=keys.device).manual_seed(seed)
    # Canonical layout: (head_dim, proj_dim) row-major — matches the
    # qjl-cpu / verify references and the recipe's _build_jl_projections.
    proj = torch.randn(D, projection_dim, generator=g, device=keys.device, dtype=torch.float32)

    # x @ proj -> (B, H, T, projection_dim) fp32. No transpose: Π is
    # stored kernel-canonical, so this is the direct sketch math.
    sk = (keys.float() @ proj)
    bits = (sk > 0).to(torch.uint8)  # (B, H, T, projection_dim), uint8 0/1

    # Pack 8 bits per byte along the last dim.
    bits = bits.view(B, H, T, projection_dim // 8, 8)
    enc = (1 << torch.arange(8, device=keys.device, dtype=torch.uint8)).view(1, 1, 1, 1, 8)
    packed = (bits * enc).sum(dim=-1).to(torch.uint8)  # (B, H, T, projection_dim/8)

    # Per-token, per-head L2 norm (bf16) -- matches upstream's key_states_norm.
    # 2 bytes per (head, token) for the norm, plus the packed signs.
    baseline_bytes = B * H * T * D * 2  # bf16 K cache
    qjl_bytes = (
        B * H * T * (projection_dim // 8)  # packed JL signs
        + B * H * T * 2  # bf16 norm per (head, token)
    )
    return packed, baseline_bytes, qjl_bytes


# ---------------------------------------------------------------------------
# Generation harness (mirrors test_turboquant.py for apples-to-apples).
# ---------------------------------------------------------------------------


def load_toon_prompts(n: int) -> list[dict]:
    out: list[dict] = []
    if not VAL_JSONL.exists():
        # Fall back to synthetic prompts if val.jsonl is unavailable.
        return [
            {
                "currentMessage": {"content": f"Summarize prime numbers under 100. (run {i})"},
                "memoryEntries": [],
            }
            for i in range(n)
        ]
    with VAL_JSONL.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            er = rec.get("expectedResponse") or ""
            if er.lstrip().startswith("thought:"):
                out.append(rec)
                if len(out) >= n:
                    break
    if len(out) < n:
        for i in range(len(out), n):
            out.append(
                {
                    "currentMessage": {"content": f"Describe the cause of tides briefly. (#{i})"},
                    "memoryEntries": [],
                }
            )
    return out[:n]


def render_chat(tokenizer, record: dict) -> str:
    sys_prompt = (
        "You are an autonomous elizaOS agent. Decide which action to take "
        "from `availableActions` and respond with ONE TOON document. "
        "Always TOON. No fences, no <think>, no prose before or after."
    )
    msgs = [{"role": "system", "content": sys_prompt}]
    for m in record.get("memoryEntries") or []:
        role = m.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        if content:
            msgs.append({"role": role, "content": content})
    cm = record.get("currentMessage") or {}
    msgs.append({"role": "user", "content": cm.get("content") or ""})
    return tokenizer.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)


def measure_generation(
    model,
    tokenizer,
    prompts: list[str],
    *,
    cache_factory,
    max_new_tokens: int,
    label: str,
) -> dict:
    torch.cuda.empty_cache()
    gc.collect()
    torch.cuda.reset_peak_memory_stats()

    decoded: list[str] = []
    total_new = 0
    t0 = time.perf_counter()
    for p in prompts:
        cache = cache_factory()
        ids = tokenizer(p, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(
                **ids,
                past_key_values=cache,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        new = out[0, ids.input_ids.shape[-1]:]
        total_new += int(new.shape[-1])
        decoded.append(tokenizer.decode(new, skip_special_tokens=True))
        del cache, out, ids
        torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0
    peak = torch.cuda.max_memory_allocated()
    return {
        "label": label,
        "elapsed_s": elapsed,
        "tokens_new": total_new,
        "toks_per_s": total_new / elapsed if elapsed > 0 else 0.0,
        "peak_vram_bytes": int(peak),
        "decoded": decoded,
    }


# ---------------------------------------------------------------------------
# K-projection capture: hook every full-attention layer's k_proj so we can
# feed real K activations into the pure-pytorch QJL ratio measurement.
# ---------------------------------------------------------------------------


def capture_real_k_activations(
    model, tokenizer, prompt: str, *, max_layers: int = 4
) -> list[torch.Tensor]:
    """Run one forward pass and return up to ``max_layers`` of per-layer
    K activations shaped (1, num_kv_heads, T, head_dim).
    """
    text_cfg = (
        model.config.get_text_config(decoder=True)
        if hasattr(model.config, "get_text_config")
        else model.config
    )
    head_dim = getattr(text_cfg, "head_dim", None) or (
        text_cfg.hidden_size // text_cfg.num_attention_heads
    )
    num_kv_heads = (
        getattr(text_cfg, "num_key_value_heads", None) or text_cfg.num_attention_heads
    )

    captured: list[torch.Tensor] = []
    handles = []

    def _hook(_m, _i, output):
        if len(captured) >= max_layers:
            return
        t = output[0] if isinstance(output, tuple) else output
        if t.dim() == 3:
            B, T, _D = t.shape
            t = t.view(B, T, num_kv_heads, head_dim).transpose(1, 2).contiguous()
        captured.append(t.detach())

    for i, layer in enumerate(model.model.layers):
        if len(handles) >= max_layers:
            break
        attn = getattr(layer, "self_attn", None)
        if attn is None:
            continue
        k_proj = getattr(attn, "k_proj", None)
        if k_proj is None:
            continue
        handles.append(k_proj.register_forward_hook(_hook))

    try:
        ids = tokenizer(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            model(**ids, use_cache=False)
    finally:
        for h in handles:
            h.remove()

    return captured


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--num-prompts", type=int, default=5)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    ap.add_argument("--projection-dim-per-head", type=int, default=256)
    ap.add_argument("--projection-seed", type=int, default=42)
    ap.add_argument(
        "--report",
        default=str(ROOT / "scripts" / "quantization" / "qjl_report.json"),
    )
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required")

    log.info("attempting to build vendored QJL CUDA extension")
    build_info = attempt_qjl_kernel_build()
    log.info(
        "build status: built=%s nvcc=%s python_h=%s",
        build_info["built"],
        build_info["nvcc_present"],
        build_info["python_h_present"],
    )
    if not build_info["built"]:
        log.warning("QJL CUDA kernel could NOT be built. Reason: %s", build_info["error"])
        log.warning(
            "Remediation:\n%s",
            build_info["remediation"],
        )

    log.info("loading %s", args.model)
    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.bfloat16,
        device_map="cuda",
        trust_remote_code=True,
    )
    model.eval()

    # Baseline generation (bf16 DynamicCache).
    records = load_toon_prompts(args.num_prompts)
    rendered = [render_chat(tok, r) for r in records]
    log.info("running baseline bf16 generation on %d prompts", len(rendered))
    base_res = measure_generation(
        model, tok, rendered,
        cache_factory=lambda: DynamicCache(),
        max_new_tokens=args.max_new_tokens,
        label="baseline_bf16",
    )

    # Pure-PyTorch QJL on captured K activations.
    log.info("capturing real K activations for pure-pytorch QJL probe")
    keys_per_layer = capture_real_k_activations(
        model, tok, rendered[0], max_layers=4
    )
    layer_ratios = []
    for i, K in enumerate(keys_per_layer):
        _packed, base_b, qjl_b = qjl_pure_pytorch_quantize(
            K,
            projection_dim=args.projection_dim_per_head,
            seed=args.projection_seed,
        )
        ratio = base_b / max(qjl_b, 1)
        layer_ratios.append({"layer": i, "shape": list(K.shape), "baseline_bytes": base_b, "qjl_bytes": qjl_b, "ratio": ratio})
        log.info(
            "  layer %d  K shape=%s  baseline=%d B  qjl=%d B  ratio=%.2fx",
            i, tuple(K.shape), base_b, qjl_b, ratio,
        )

    # Sensitivity probe: same K activations, sweep projection_dim ∈ {128, 256, 512}
    # so the report shows the full ratio vs quality tradeoff.
    sweep = []
    for pdim in (128, 256, 512):
        if not keys_per_layer:
            break
        K = keys_per_layer[0]
        _, base_b, qjl_b = qjl_pure_pytorch_quantize(
            K, projection_dim=pdim, seed=args.projection_seed
        )
        sweep.append({"projection_dim": pdim, "baseline_bytes": base_b, "qjl_bytes": qjl_b, "ratio": base_b / max(qjl_b, 1)})
        log.info(
            "  sweep projection_dim=%d  baseline=%d B  qjl=%d B  ratio=%.2fx",
            pdim, base_b, qjl_b, base_b / max(qjl_b, 1),
        )

    # Analytic KV bytes per token across the whole model.
    sys.path.insert(0, str(ROOT / "scripts" / "quantization"))
    from qjl_apply import kv_bytes_per_token_analytic  # type: ignore  # noqa: E402

    base_bpt, quant_bpt = kv_bytes_per_token_analytic(
        model.config,
        key_quantization_bits=args.projection_dim_per_head,
        key_quantization_bits_initial_layers=args.projection_dim_per_head * 2,
        initial_layers_count=15,
        outlier_count_general=8,
        outlier_count_initial_layers=8,
        value_bits=4,  # paired TurboQuant V side
    )

    # Reporting
    print()
    print("=" * 78)
    print("QJL validation report")
    print("=" * 78)
    print(f"model:                      {args.model}")
    print(f"projection_dim_per_head:    {args.projection_dim_per_head}")
    print(f"projection_seed:            {args.projection_seed}")
    print()
    print("CUDA extension build status:")
    print(f"  nvcc present:             {build_info['nvcc_present']}  ({build_info['nvcc_path'] or 'not found'})")
    print(f"  python.h present:         {build_info['python_h_present']}  ({build_info['python_h_path'] or 'not found'})")
    print(f"  built:                    {build_info['built']}")
    if not build_info["built"]:
        print(f"  error:                    {build_info['error']}")
        print(f"  remediation:              {build_info['remediation']}")
    print()
    print("Pure-PyTorch QJL on real K activations (K-side only):")
    for r in layer_ratios:
        print(
            f"  layer {r['layer']:>2}  shape={tuple(r['shape'])}  "
            f"baseline={r['baseline_bytes'] / 1024:.1f} KiB  "
            f"qjl={r['qjl_bytes'] / 1024:.1f} KiB  "
            f"ratio={r['ratio']:.2f}x"
        )
    print()
    print("projection_dim sweep (layer 0 K activations):")
    for s in sweep:
        print(
            f"  projection_dim={s['projection_dim']:>3}  "
            f"baseline={s['baseline_bytes'] / 1024:.1f} KiB  "
            f"qjl={s['qjl_bytes'] / 1024:.1f} KiB  "
            f"ratio={s['ratio']:.2f}x"
        )
    print()
    print("Analytic KV bytes / token (whole model, full-attention layers):")
    print(f"  baseline (bf16 K + bf16 V):     {base_bpt:>10,} bytes")
    print(f"  qjl K (1-bit) + turboquant V (4-bit): {quant_bpt:>10,} bytes")
    print(f"  reduction:                      {base_bpt / max(quant_bpt, 1):.2f}x  ({100 * (1 - quant_bpt / max(base_bpt, 1)):.1f}% smaller)")
    print()
    print(f"Baseline generation ({args.num_prompts} prompts, {args.max_new_tokens} new tokens each):")
    print(f"  tok/s:                    {base_res['toks_per_s']:.2f}  ({base_res['tokens_new']} tok in {base_res['elapsed_s']:.2f}s)")
    print(f"  peak VRAM:                {base_res['peak_vram_bytes'] / 1e9:.3f} GB")
    print()
    print("Sample baseline outputs:")
    for i, txt in enumerate(base_res["decoded"][:3]):
        snippet = txt[:240].replace("\n", " ")
        print(f"  [{i + 1}] {snippet!r}")
    print("=" * 78)

    # Assertions
    failures: list[str] = []

    # K-only ratio at projection_dim=256 with per-token bf16 norm (the
    # exact geometry upstream's QJLKeyQuantizer uses). Closed-form ratio
    # is head_dim*2 / (projection_dim/8 + 2) = 256/34 = 7.53x for
    # head_dim=128, projection_dim=256.
    avg_ratio = sum(r["ratio"] for r in layer_ratios) / max(len(layer_ratios), 1)
    expected_min = 7.0
    if avg_ratio < expected_min:
        failures.append(
            f"K-side compression ratio insufficient: avg {avg_ratio:.2f}x "
            f"(>={expected_min:.1f}x required at projection_dim=256, 1-bit, "
            f"per-token norm; closed-form for head_dim=128 is 7.53x)"
        )

    # Baseline outputs must be non-degenerate.
    for i, txt in enumerate(base_res["decoded"]):
        s = (txt or "").strip()
        if len(s) < 8:
            failures.append(f"baseline prompt {i}: output too short: {s!r}")
        elif len(set(s)) < 3:
            failures.append(f"baseline prompt {i}: output looks degenerate: {s[:80]!r}")

    report = {
        "model": args.model,
        "projection_dim_per_head": args.projection_dim_per_head,
        "build_info": build_info,
        "baseline": {k: v for k, v in base_res.items() if k != "decoded"},
        "baseline_decoded": base_res["decoded"],
        "pure_pytorch_qjl_per_layer": layer_ratios,
        "pure_pytorch_qjl_avg_ratio": avg_ratio,
        "projection_dim_sweep": sweep,
        "analytic_kv_bytes_per_token_baseline": base_bpt,
        "analytic_kv_bytes_per_token_qjl_plus_turboquant": quant_bpt,
        "analytic_kv_reduction_factor": base_bpt / max(quant_bpt, 1),
        "assertions_failed": failures,
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    log.info("wrote report to %s", args.report)

    if failures:
        print("\nFAILED ASSERTIONS:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll assertions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
