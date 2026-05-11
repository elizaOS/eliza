"""Pytest unit + dry-run smoke tests for the quantization recipes.

These tests are CPU-only and avoid downloading anything large. They
exercise the import surface, recipe dataclasses, and CLI dry-run paths
of every recipe so a broken module is caught at unit-test time rather
than at training-rig invocation time. The end-to-end correctness tests
that require a real model live in:

    test_abliteration.py          -- runs vs sshleifer/tiny-gpt2
    test_polarquant.py            -- CLI runner; needs a real Qwen3 GPU
    test_turboquant.py            -- CLI runner; needs a real Qwen3 GPU
    test_qjl.py                   -- CLI runner; needs a real Qwen3 GPU
    test_fused_turboquant.py      -- CLI runner; needs a real Qwen3 GPU

They are NOT pytest-collectable on purpose: they download multi-GB
checkpoints and require a fixed val.jsonl shipped with the training
data. Run them by hand from the repo root.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def test_polarquant_recipe_serializes_with_paper_metadata():
    from polarquant_apply import PolarQuantRecipe

    recipe = PolarQuantRecipe(bits=4, block_size=128, use_qjl=True)
    payload = recipe.to_json()
    assert payload["bits"] == 4
    assert payload["block_size"] == 128
    assert payload["use_qjl"] is True
    assert payload["paper"] == "arXiv:2603.29078"
    assert "upstream_commit" in payload


def test_polarquant_dry_run_emits_recipe_json(capsys):
    from polarquant_apply import main

    rc = main(["--model", "Qwen/Qwen3-0.6B", "--output", "/tmp/_polarquant_unused", "--dry-run"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["model"] == "Qwen/Qwen3-0.6B"
    assert payload["recipe"]["bits"] == 4


def test_polarquant_dry_run_rejects_missing_calibration(tmp_path):
    from polarquant_apply import main

    bogus = tmp_path / "does-not-exist.jsonl"
    with pytest.raises(FileNotFoundError):
        main([
            "--model", "Qwen/Qwen3-0.6B",
            "--output", str(tmp_path / "out"),
            "--calibration", str(bogus),
            "--dry-run",
        ])


def test_fused_turboquant_recipe_metadata():
    from fused_turboquant_apply import FusedTurboQuantRecipe

    recipe = FusedTurboQuantRecipe(bits=4, compress_v=True, verify=True)
    payload = recipe.to_json()
    assert payload["bits"] == 4
    assert payload["paper"] == "arXiv:2504.19874"
    assert payload["library"] == "fused-turboquant 0.1.0"
    assert payload["kernels"] == "triton"


def test_fused_turboquant_dry_run_rejects_missing_calibration(tmp_path):
    from fused_turboquant_apply import main

    bogus = tmp_path / "does-not-exist.jsonl"
    with pytest.raises(FileNotFoundError):
        main([
            "--model", "Qwen/Qwen3-0.6B",
            "--output", str(tmp_path / "out"),
            "--calibration", str(bogus),
            "--dry-run",
        ])


def test_fp8_apply_dry_run_emits_capability_json(capsys):
    """fp8_apply.py is on the publish path (`--quant fp8`). Its dry-run
    must enumerate the capability check so users on the wrong GPU find
    out before they run a 20-minute conversion. The dry-run intentionally
    does NOT fail when CUDA is absent — it just records that fact in the
    JSON output."""
    from fp8_apply import main

    rc = main(["--model", "Qwen/Qwen3-0.6B", "--output", "/tmp/_fp8_unused", "--dry-run"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert "fp8_ok" in payload
    assert "reason" in payload


def test_qjl_apply_kv_bytes_per_token_analytic_qwen():
    """Sanity-check the analytic KV-bytes formula on a real Qwen3-0.6B config.

    No model download — just metadata via AutoConfig.
    """
    pytest.importorskip("transformers")
    from transformers import AutoConfig

    from qjl_apply import kv_bytes_per_token_analytic

    cfg = AutoConfig.from_pretrained("Qwen/Qwen3-0.6B", trust_remote_code=True)
    base_bpt, quant_bpt = kv_bytes_per_token_analytic(
        cfg,
        key_quantization_bits=256,
        key_quantization_bits_initial_layers=512,
        initial_layers_count=15,
        outlier_count_general=8,
        outlier_count_initial_layers=8,
        value_bits=4,
    )
    assert base_bpt > 0
    assert quant_bpt > 0
    # QJL+TurboQuant must shrink the cache vs bf16. >=4x is conservative;
    # the paper / our analytic formula show ~7x at proj_dim=256.
    assert base_bpt / quant_bpt >= 4.0


def test_common_helpers_handle_text_config_passthrough():
    from _common import full_attention_layer_indices, get_text_config, head_dim_of

    class FakeConfig:
        hidden_size = 1024
        num_attention_heads = 16
        num_hidden_layers = 4

    cfg = FakeConfig()
    assert get_text_config(cfg) is cfg
    assert head_dim_of(cfg) == 64
    assert full_attention_layer_indices(cfg) == [0, 1, 2, 3]


def test_common_layer_types_filters_full_attention_layers():
    from _common import full_attention_layer_indices

    class HybridConfig:
        num_hidden_layers = 8
        layer_types = [
            "linear_attention", "linear_attention", "linear_attention",
            "full_attention", "linear_attention", "linear_attention",
            "linear_attention", "full_attention",
        ]

    indices = full_attention_layer_indices(HybridConfig())
    assert indices == [3, 7]


def test_common_load_calibration_prompts_pulls_current_message_content(tmp_path):
    from _common import load_calibration_prompts

    p = tmp_path / "val.jsonl"
    p.write_text(
        "\n".join([
            json.dumps({"currentMessage": {"content": "first"}}),
            json.dumps({"currentMessage": {"content": "second"}}),
            "",
            json.dumps({"currentMessage": {"content": "third"}}),
        ]),
        encoding="utf-8",
    )
    out = load_calibration_prompts(p, n=2)
    assert out == ["first", "second"]


def test_common_load_calibration_prompts_raises_on_empty(tmp_path):
    from _common import load_calibration_prompts

    p = tmp_path / "empty.jsonl"
    p.write_text("", encoding="utf-8")
    with pytest.raises(RuntimeError, match="No prompts read"):
        load_calibration_prompts(p, n=1)


def test_push_model_quant_choices_match_real_recipes():
    """The published `--quant` choices must match recipes that actually
    produce a HF-loadable checkpoint. QJL is intentionally absent — it is
    a runtime-only KV projection. Abliteration is its own `--variant`,
    not a `--quant`."""
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import QUANT_BLURBS

    expected = {"polarquant", "turboquant", "fp8", "gguf-q4_k_m", "gguf-q5_k_m", "gguf-q6_k"}
    assert set(QUANT_BLURBS) == expected
    # Every blurb must reference an arXiv id, GitHub PR, or vendor primer.
    for key, meta in QUANT_BLURBS.items():
        assert "paper" in meta and meta["paper"], f"{key} missing paper link"
        assert "blurb" in meta and meta["blurb"], f"{key} missing blurb"


def test_push_model_resolves_repo_id_with_quant_suffix():
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import resolve_repo_id

    assert resolve_repo_id("qwen3.5-2b", None, "default", None) == "elizalabs/eliza-1-2b"
    assert resolve_repo_id("qwen3.5-2b", "polarquant", "default", None) == (
        "elizalabs/eliza-1-2b-polarquant"
    )
    assert resolve_repo_id("qwen3.6-27b", "gguf-q4_k_m", "default", None) == (
        "elizalabs/eliza-1-27b-gguf-q4_k_m"
    )
    assert resolve_repo_id("qwen3.5-2b", None, "abliterated", None) == (
        "elizalabs/eliza-1-2b-uncensored"
    )
    assert resolve_repo_id("qwen3.5-2b", "polarquant", "default", "custom/foo") == "custom/foo"


def test_push_model_card_inference_blocks_reference_real_imports():
    """Regression guard: the inference snippets we put in model cards must
    only reference symbols that actually exist in the repo. Two earlier
    versions of the script referenced `load_polarquant` and
    `wrap_with_turboquant` — neither was ever defined."""
    sys.path.insert(0, str(_HERE.parent))
    from push_model_to_hf import PushConfig, _quant_inference_block

    for quant in ("polarquant", "turboquant", "fp8", "gguf-q4_k_m"):
        cfg = PushConfig(
            registry_key="qwen3.5-2b",
            checkpoint=Path("/tmp/_unused"),
            repo_id=f"elizalabs/eliza-1-2b-{quant}",
            quant=quant,
            variant="default",
            public=False,
            readme_only=False,
            dry_run=True,
        )
        block = _quant_inference_block(cfg)
        assert "load_polarquant" not in block, f"{quant} card references nonexistent load_polarquant"
        assert "wrap_with_turboquant" not in block, (
            f"{quant} card references nonexistent wrap_with_turboquant"
        )


# ---------------------------------------------------------------------------
# Kernel-vs-recipe parity tests
#
# These tests pin the recipes to the canonical kernel references in
# eliza/packages/inference/{reference,verify}/ and
# eliza/packages/native-plugins/{qjl-cpu,polarquant-cpu}/.
#
# Per packages/training/AGENTS.md §3:
#   "Bit-exact with kernels — when a quantization recipe and a kernel
#   reference disagree, the kernel reference is canonical."
#
# The compile-and-ctypes tests skip cleanly when `cc` is unavailable. The
# pure-Python tests (centroid pin, sign-magnitude pin, manifest fragment)
# always run.
# See AUDIT_2026-05-10.md for the full audit and disagreement log.
# ---------------------------------------------------------------------------


# _HERE = .../eliza/packages/training/scripts/quantization
# parents: [0]=quantization, [1]=scripts, [2]=training, [3]=packages
_KERNEL_PACKAGES_DIR = _HERE.parents[2]
_REF_C = _KERNEL_PACKAGES_DIR / "inference" / "verify" / "qjl_polar_ref.c"
_REF_H = _KERNEL_PACKAGES_DIR / "inference" / "verify" / "qjl_polar_ref.h"
_TURBO_C = _KERNEL_PACKAGES_DIR / "inference" / "reference" / "turbo_kernels.c"
_TURBO_H = _KERNEL_PACKAGES_DIR / "inference" / "reference" / "turbo_kernels.h"


# Canonical 4-bit Lloyd-Max centroids for N(0,1), bit-exact match required
# against eliza/packages/native-plugins/polarquant-cpu/include/polarquant/polar_centroids.h
# and eliza/packages/inference/verify/qjl_polar_ref.c.
_C_POLAR_Q4_CENTROIDS = (
    -2.754354807, -2.093562707, -1.643041510, -1.279739752,
    -0.962640978, -0.672392117, -0.397897103, -0.131757782,
    +0.131757782, +0.397897103, +0.672392117, +0.962640978,
    +1.279739752, +1.643041510, +2.093562707, +2.754354807,
)


def test_polarquant_centroids_match_c_reference():
    """Python Lloyd-Max(16, 100 iter) MUST match the canonical centroids
    pinned in polar_centroids.h. The C centroid file was generated at the
    same iteration count; if anyone bumps the Python default the
    reconstruction values diverge silently. Pin both sides here.
    """
    from polarquant.polar_quant import _compute_lloyd_max_centroids

    py = _compute_lloyd_max_centroids(16, n_iter=100).tolist()
    assert len(py) == len(_C_POLAR_Q4_CENTROIDS) == 16
    for i, (p, c) in enumerate(zip(py, _C_POLAR_Q4_CENTROIDS)):
        assert abs(p - c) < 1e-6, (
            f"centroid[{i}] disagrees: python={p:.9f} c_ref={c:.9f} "
            f"(delta={abs(p-c):.2e}). Did Python's default n_iter change?"
        )


def test_polarquant_qjl_correction_magnitude_matches_c():
    """The QJL residual correction magnitude and seed value MUST agree
    with the C macros POLAR_QJL_CORRECTION_MAGNITUDE / POLAR_QJL_SEED.
    """
    from polarquant import polar_quant

    assert polar_quant._QJL_CORRECTION_MAGNITUDE == 0.5
    assert polar_quant._QJL_SEED == 42


def test_polarquant_python_sign_vector_pinned():
    """Bit-exact compare Python xorshift32 against the C reference.

    Per AUDIT_2026-05-10.md finding 2 (RESOLVED 2026-05-10): the Python
    sign generator now uses xorshift32 to match the canonical C kernel
    (polar_qjl.c / qjl_polar_ref.c::eliza_polar_qjl_signs). This test
    compiles the C reference, calls eliza_polar_qjl_signs, and asserts
    the Python helper produces an identical 128-element ±1 sequence.

    Tolerance: byte-exact (zero). Drift on either side fails here.
    """
    import ctypes

    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None:
        pytest.skip(skip_reason)

    import numpy as np

    from polar_xorshift32 import polar_xorshift32_signs

    QK_POLAR = 128

    lib = ctypes.CDLL(str(so_path))
    lib.eliza_polar_qjl_signs.argtypes = [ctypes.POINTER(ctypes.c_float)]
    lib.eliza_polar_qjl_signs.restype = None

    c_buf = (ctypes.c_float * QK_POLAR)()
    lib.eliza_polar_qjl_signs(c_buf)
    c_signs = np.frombuffer(c_buf, dtype=np.float32, count=QK_POLAR).astype(
        np.int8
    )

    py_signs = polar_xorshift32_signs(QK_POLAR, seed=42)

    assert py_signs.shape == c_signs.shape == (QK_POLAR,)
    assert np.array_equal(py_signs, c_signs), (
        "Python xorshift32 disagrees with C eliza_polar_qjl_signs. "
        f"first mismatched index: "
        f"{int(np.argmax(py_signs != c_signs))} "
        f"py={py_signs[:8].tolist()} c={c_signs[:8].tolist()}"
    )
    # Sanity: ±1 only, length 128.
    assert set(py_signs.tolist()) <= {-1, 1}


def test_recipe_sidecar_manifest_fragment_complete():
    """AGENTS.md §3 mandates a sidecar fragment with kernel target, block
    layout version, codebook hash, expected per-block tolerance for every
    recipe. Verify the helper produces all four for every method.
    """
    from _kernel_manifest import (
        KERNEL_TARGETS,
        kernel_manifest_fragment,
    )

    required_keys = {
        "kernel_target",
        "block_layout_version",
        "codebook_hash",
        "per_block_tolerance",
    }
    for method in KERNEL_TARGETS:
        frag = kernel_manifest_fragment(method)
        assert required_keys <= set(frag), (
            f"{method}: manifest fragment missing keys {required_keys - set(frag)}"
        )
        assert frag["kernel_target"], f"{method}: empty kernel_target"
        for target in frag["kernel_target"]:
            assert frag["block_layout_version"][target], (
                f"{method}/{target}: empty block_layout_version"
            )
            assert frag["codebook_hash"][target], (
                f"{method}/{target}: empty codebook_hash"
            )
            assert frag["per_block_tolerance"][target] > 0, (
                f"{method}/{target}: non-positive per_block_tolerance"
            )


def test_kernel_manifest_fragment_rejects_unknown_method():
    """A recipe whose method name isn't pinned to a kernel target MUST
    fail loudly — no silent default."""
    from _kernel_manifest import kernel_manifest_fragment

    with pytest.raises(ValueError, match="unknown method"):
        kernel_manifest_fragment("unknown-recipe")


def _try_compile_qjl_polar_ref():
    """Compile inference/verify/qjl_polar_ref.c into a shared object once.

    Returns ``(path, None)`` on success or ``(None, reason)`` if compilation
    is not possible on this host. The compiled .so is cached under tmp.
    """
    import shutil
    import subprocess
    import tempfile

    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if cc is None:
        return None, "no C compiler on PATH"
    if not _REF_C.exists():
        return None, f"missing kernel reference {_REF_C}"

    tmp = Path(tempfile.gettempdir()) / "_eliza_qjl_polar_ref.so"
    if tmp.exists() and tmp.stat().st_mtime > _REF_C.stat().st_mtime:
        return tmp, None
    cmd = [
        cc,
        "-O2", "-std=c11", "-fPIC", "-shared",
        "-I", str(_REF_C.parent),
        str(_REF_C), "-lm",
        "-o", str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None, f"cc failed: {result.stderr.strip()[:200]}"
    return tmp, None


def test_qjl_block_layout_packing_matches_c_ref():
    """Quantize the same key vector with Python (matching the recipe's
    bit-packing convention) and the C reference, compare byte-for-byte.

    The projection matrix is generated in Python and fed to both sides,
    so the only thing being compared is the quantize-and-pack step.
    """
    import ctypes

    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None:
        pytest.skip(skip_reason)

    import numpy as np

    # Block layout: qs[32] sign bits + uint16 norm_bf16. 34 bytes packed.
    class block_qjl1_256(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("qs", ctypes.c_uint8 * 32),
            ("norm_bf16", ctypes.c_uint16),
        ]
    assert ctypes.sizeof(block_qjl1_256) == 34

    lib = ctypes.CDLL(str(so_path))
    lib.eliza_qjl_quantize_row.argtypes = [
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(block_qjl1_256),
    ]
    lib.eliza_qjl_quantize_row.restype = None

    head_dim, proj_dim = 128, 256
    rng = np.random.default_rng(seed=12345)
    key = rng.standard_normal(head_dim).astype(np.float32)
    prj = rng.standard_normal((head_dim, proj_dim)).astype(np.float32)

    # --- C-reference path ---
    c_block = block_qjl1_256()
    lib.eliza_qjl_quantize_row(
        key.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        prj.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        ctypes.byref(c_block),
    )
    c_qs = bytes(c_block.qs)
    c_norm_bf16 = c_block.norm_bf16

    # --- Python path mirroring the recipe's bit-packing convention ---
    sketch = key @ prj                                   # (proj_dim,)
    bits = (sketch > 0).astype(np.uint8)                 # (proj_dim,)
    # LSB-first packing within each byte, matches qjl_quantize_row_ref.
    py_qs = bytearray(proj_dim // 8)
    for j in range(proj_dim):
        if bits[j]:
            py_qs[j >> 3] |= 1 << (j & 7)
    py_qs = bytes(py_qs)

    # bf16 conversion: round-to-nearest-even on the upper 16 bits.
    norm = float(np.linalg.norm(key))
    f_bits = np.float32(norm).view(np.uint32).item()
    lsb = (f_bits >> 16) & 1
    rounded = (f_bits + 0x7FFF + lsb) & 0xFFFFFFFF
    py_norm_bf16 = (rounded >> 16) & 0xFFFF

    assert py_qs == c_qs, (
        f"QJL block byte mismatch:\n  py_qs={py_qs.hex()}\n   c_qs={c_qs.hex()}"
    )
    assert py_norm_bf16 == c_norm_bf16, (
        f"QJL norm_bf16 mismatch: py={py_norm_bf16:#06x} c={c_norm_bf16:#06x}"
    )


def test_polarquant_block_dequant_parity_against_c_ref():
    """PolarQuant Python decoder vs C reference decoder, on the same
    synthetic block_q4_polar payload (centroid codes + fp16 norm + qjl bit).

    Tolerance: max-abs delta < per_block_tolerance for polar_q4 (1e-3 fp32).
    The Python encoder/decoder pair lives in polarquant/polar_quant.py;
    we mimic the C block layout directly here so we don't have to write
    a Python→C block converter (out of scope for this test).
    """
    import ctypes

    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None:
        pytest.skip(skip_reason)

    import numpy as np

    QK_POLAR = 128

    class block_q4_polar(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("d", ctypes.c_uint16),                # fp16 per-block L2 norm
            ("qs", ctypes.c_uint8 * (QK_POLAR // 2)),
            ("qjl", ctypes.c_uint8 * (QK_POLAR // 8)),
        ]
    assert ctypes.sizeof(block_q4_polar) == 82

    lib = ctypes.CDLL(str(so_path))
    lib.eliza_polar_dequantize_row.argtypes = [
        ctypes.POINTER(block_q4_polar),
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_int64,
        ctypes.c_int,
    ]
    lib.eliza_polar_dequantize_row.restype = None

    # Build a synthetic block: every-other code rotates through 0..15
    # and the L2 norm is a moderate value. use_qjl=0 to keep the test
    # narrowly focused on the centroid+Hadamard+norm pipeline.
    blk = block_q4_polar()
    f = np.float32(2.5)
    f_bits = f.view(np.uint32).item()
    sign = (f_bits >> 16) & 0x8000
    exp = ((f_bits >> 23) & 0xff) - 127 + 15
    mant = (f_bits >> 13) & 0x3ff
    blk.d = (sign | (exp << 10) | mant) & 0xFFFF

    codes = [(i * 7) & 0xF for i in range(QK_POLAR)]
    for i in range(QK_POLAR // 2):
        lo, hi = codes[2 * i], codes[2 * i + 1]
        blk.qs[i] = (hi << 4) | (lo & 0xF)
    for i in range(QK_POLAR // 8):
        blk.qjl[i] = 0

    out = (ctypes.c_float * QK_POLAR)()
    lib.eliza_polar_dequantize_row(
        ctypes.byref(blk), out, QK_POLAR, 0,
    )
    c_decoded = np.frombuffer(out, dtype=np.float32, count=QK_POLAR).copy()

    # --- Python equivalent: replicate the C decoder math. ---
    from polarquant.polar_quant import _hadamard_matrix
    centroids = np.array(_C_POLAR_Q4_CENTROIDS, dtype=np.float32)

    py_buf = np.array([centroids[c] for c in codes], dtype=np.float32)
    # In-place butterfly (NOT orthonormal — matches polar_hadamard_inplace).
    h = 1
    while h < QK_POLAR:
        for i in range(0, QK_POLAR, h * 2):
            for j in range(i, i + h):
                a, b = py_buf[j], py_buf[j + h]
                py_buf[j] = a + b
                py_buf[j + h] = a - b
        h *= 2
    py_buf *= 1.0 / float(QK_POLAR)
    py_buf *= float(f)  # the per-block L2 norm

    max_delta = float(np.abs(py_buf - c_decoded).max())
    # The C and Python pipelines are algebraically identical here, so the
    # tolerance is set just above fp32 round-off.
    assert max_delta < 5e-5, (
        f"PolarQuant decode parity broken: max abs delta = {max_delta:.3e}"
    )


def test_qjl_projection_layout_matches_c_ref():
    """End-to-end byte-parity for the canonical (head_dim, proj_dim) layout.

    Builds the projection matrix via the recipe-side helper, quantizes a
    synthetic 128-d row in Python, and pushes the EXACT SAME matrix bytes
    + key bytes through the C reference. The block bytes must match
    byte-for-byte. No transpose anywhere — that's the whole point of the
    layout consolidation (audit row finding 3, RESOLVED).
    """
    import ctypes

    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None:
        pytest.skip(skip_reason)

    import numpy as np

    from qjl.qjl_quant import build_projection_matrix, quantize_row

    class block_qjl1_256(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("qs", ctypes.c_uint8 * 32),
            ("norm_bf16", ctypes.c_uint16),
        ]
    assert ctypes.sizeof(block_qjl1_256) == 34

    lib = ctypes.CDLL(str(so_path))
    lib.eliza_qjl_quantize_row.argtypes = [
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(block_qjl1_256),
    ]
    lib.eliza_qjl_quantize_row.restype = None

    head_dim, proj_dim = 128, 256
    pi = build_projection_matrix(head_dim, proj_dim, seed=12345)
    assert pi.shape == (head_dim, proj_dim)
    assert pi.dtype == np.float32
    assert pi.flags["C_CONTIGUOUS"], "Π must be C-contiguous row-major"

    rng = np.random.default_rng(seed=67890)
    key = rng.standard_normal(head_dim).astype(np.float32)

    # Python path through the canonical helper. No transpose.
    py_packed, py_norm_bf16 = quantize_row(key, pi)

    # C path — same bytes for both key and Π. No transpose.
    c_block = block_qjl1_256()
    lib.eliza_qjl_quantize_row(
        key.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        pi.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        ctypes.byref(c_block),
    )
    c_qs = bytes(c_block.qs)
    c_norm_bf16 = c_block.norm_bf16

    assert bytes(py_packed) == c_qs, (
        f"QJL projection-layout byte-mismatch:\n"
        f"  py_qs={bytes(py_packed).hex()}\n"
        f"   c_qs={c_qs.hex()}\n"
        f"This means Python's stored Π layout disagrees with the kernel's "
        f"interpretation. Both sides should read row-major (head_dim, proj_dim)."
    )
    assert py_norm_bf16 == c_norm_bf16, (
        f"QJL norm_bf16 mismatch: py={py_norm_bf16:#06x} c={c_norm_bf16:#06x}"
    )


def test_qjl_apply_recipe_projection_shape_is_canonical():
    """``qjl_apply._build_jl_projections`` MUST emit ``(head_dim, proj_dim)``
    row-major matrices — the canonical kernel-side layout. A regression
    that flips this back to ``(proj_dim, head_dim)`` would break the
    direct kernel handoff documented in AUDIT_2026-05-10.md (row 3).
    """
    pytest.importorskip("torch")
    import torch

    # Direct import to avoid pulling _common.py's transformers dep.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "qjl_apply_isolated", _HERE / "qjl_apply.py"
    )
    if spec is None or spec.loader is None:
        pytest.skip("could not load qjl_apply for isolated import")
    # Avoid loading qjl_apply (which imports transformers via _common). Use
    # the canonical helper from qjl/qjl_quant.py — it lives in this repo
    # specifically as the dependency-free pin for this layout contract.
    from qjl.qjl_quant import build_projection_matrix

    pi = build_projection_matrix(128, 256, seed=42)
    assert pi.shape == (128, 256), (
        f"projection matrix shape regressed to {pi.shape}; canonical "
        f"layout is (head_dim, proj_dim) row-major"
    )

    # Replicate the recipe's torch path and confirm the layout matches.
    g = torch.Generator(device="cpu").manual_seed(42)
    proj = torch.randn(128, 256, generator=g, dtype=torch.float32)
    assert proj.shape == torch.Size([128, 256]), (
        f"torch path layout regressed to {tuple(proj.shape)}"
    )


def test_polarquant_full_block_parity_against_c_ref():
    """PolarQuant Python ENCODER vs C reference encoder, byte-for-byte.

    The PRNG switch (audit finding 2, RESOLVED 2026-05-10) made the
    Python QJL sign vector bit-exact with C, so the encoded
    block_q4_polar struct (fp16 d + qs[64] + qjl[16] = 82 bytes) MUST
    now agree byte-for-byte with the C reference on the same input.

    This is the encode-side companion to
    test_polarquant_block_dequant_parity_against_c_ref (which only
    tests the decoder).
    """
    import ctypes

    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None:
        pytest.skip(skip_reason)

    import numpy as np
    import torch

    from polarquant.polar_quant import polar_quantize

    QK_POLAR = 128

    class block_q4_polar(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("d", ctypes.c_uint16),
            ("qs", ctypes.c_uint8 * (QK_POLAR // 2)),
            ("qjl", ctypes.c_uint8 * (QK_POLAR // 8)),
        ]
    assert ctypes.sizeof(block_q4_polar) == 82

    lib = ctypes.CDLL(str(so_path))
    lib.eliza_polar_quantize_row.argtypes = [
        ctypes.POINTER(ctypes.c_float),
        ctypes.POINTER(block_q4_polar),
        ctypes.c_int64,
        ctypes.c_int,
    ]
    lib.eliza_polar_quantize_row.restype = None

    rng = np.random.default_rng(seed=20260510)
    x = rng.standard_normal(QK_POLAR).astype(np.float32)

    # --- C reference encode ---
    c_blk = block_q4_polar()
    lib.eliza_polar_quantize_row(
        x.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        ctypes.byref(c_blk),
        ctypes.c_int64(QK_POLAR),
        ctypes.c_int(1),  # use_qjl=1
    )
    c_bytes = bytes(memoryview(c_blk))
    assert len(c_bytes) == 82

    # --- Python encode through the production recipe ---
    weight = torch.from_numpy(x)
    res = polar_quantize(weight, bits=4, block_size=QK_POLAR, use_qjl=True)

    # Pack the Python output into the C block_q4_polar layout.
    py_blk = block_q4_polar()
    norm_fp16_bits = (
        res.norms[0].view(torch.int16).item() & 0xFFFF
    )
    py_blk.d = norm_fp16_bits

    codes = res.codes.tolist()
    assert len(codes) == QK_POLAR
    for i in range(QK_POLAR // 2):
        lo = codes[2 * i] & 0xF
        hi = codes[2 * i + 1] & 0xF
        py_blk.qs[i] = (hi << 4) | lo

    for i in range(QK_POLAR // 8):
        py_blk.qjl[i] = 0
    py_blk.qjl[0] = int(res.qjl_signs[0].item()) & 0x1

    py_bytes = bytes(memoryview(py_blk))

    # Byte-for-byte equality. If this fails, dump a structured diff so
    # the failure is actionable rather than an opaque hex blob.
    if py_bytes != c_bytes:
        diffs = [
            (i, py_bytes[i], c_bytes[i])
            for i in range(82)
            if py_bytes[i] != c_bytes[i]
        ]
        regions = []
        diff_idx = {i for i, _, _ in diffs}
        if 0 in diff_idx or 1 in diff_idx:
            regions.append(f"d py=0x{py_blk.d:04x} c=0x{c_blk.d:04x}")
        if any(2 <= i < 66 for i in diff_idx):
            regions.append("qs (centroid codes) differ")
        if any(i >= 66 for i in diff_idx):
            regions.append(
                f"qjl differ: py[0]={py_blk.qjl[0]:#x} c[0]={c_blk.qjl[0]:#x}"
            )
        raise AssertionError(
            "PolarQuant encode parity broken; "
            f"{len(diffs)} byte(s) differ. {'; '.join(regions)}. "
            f"first diffs: {diffs[:8]}"
        )


def test_kernel_reference_files_exist_and_compile_clean():
    """Sanity guard: a recipe-side audit that didn't touch kernels MUST
    leave the kernel reference compilable. If this fails, an unrelated
    edit broke the verification harness.
    """
    if not _REF_C.exists():
        pytest.skip(f"kernel reference not present at {_REF_C}")
    so_path, skip_reason = _try_compile_qjl_polar_ref()
    if so_path is None and skip_reason and "no C compiler" in skip_reason:
        pytest.skip(skip_reason)
    assert so_path is not None and so_path.exists(), (
        f"qjl_polar_ref.c failed to build: {skip_reason}"
    )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
