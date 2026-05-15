#!/usr/bin/env python3
"""Per-window parity test: silero-vad-cpp C runtime vs upstream Silero
v5 ONNX.

Runs both backends over the same 5 s, 16 kHz mono fixture (synthetic
mixed speech / silence) and asserts the per-window speech probability
agrees within ±0.02. The test refuses to skip:

  - Missing python `silero-vad` package or `onnxruntime` is a hard
    failure (the parity test is meaningless without the reference).
  - Missing libsilero_vad shared library or fixture GGUF is a hard
    failure (we are checking the C runtime — there is nothing to
    compare against without it).

Run from anywhere:

  python3 packages/native-plugins/silero-vad-cpp/test/silero_vad_parity_test.py \
      --library packages/native-plugins/silero-vad-cpp/build/libsilero_vad.so \
      --gguf    packages/native-plugins/silero-vad-cpp/build/silero-vad-v5.gguf

The script returns exit code 0 on parity success, non-zero otherwise.
"""
from __future__ import annotations

import argparse
import ctypes
import math
import os
import sys
from pathlib import Path
from typing import List

try:
    import numpy as np
except ImportError as e:  # pragma: no cover - hard fail
    raise SystemExit(f"[parity] numpy is required: {e}")

# Per-task spec.
PARITY_TOLERANCE = 0.02
WINDOW_SAMPLES = 512
SAMPLE_RATE_HZ = 16_000


# ── C ABI wrapper (ctypes) ────────────────────────────────────────────────

class CRuntime:
    def __init__(self, library_path: Path, gguf_path: Path) -> None:
        if not library_path.exists():
            raise FileNotFoundError(library_path)
        if not gguf_path.exists():
            raise FileNotFoundError(gguf_path)
        self.lib = ctypes.CDLL(str(library_path))
        self.lib.silero_vad_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        self.lib.silero_vad_open.restype = ctypes.c_int
        self.lib.silero_vad_reset_state.argtypes = [ctypes.c_void_p]
        self.lib.silero_vad_reset_state.restype = ctypes.c_int
        self.lib.silero_vad_process.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_float),
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_float),
        ]
        self.lib.silero_vad_process.restype = ctypes.c_int
        self.lib.silero_vad_close.argtypes = [ctypes.c_void_p]
        self.lib.silero_vad_close.restype = ctypes.c_int
        self.lib.silero_vad_active_backend.argtypes = []
        self.lib.silero_vad_active_backend.restype = ctypes.c_char_p

        self.handle = ctypes.c_void_p()
        rc = self.lib.silero_vad_open(str(gguf_path).encode("utf-8"),
                                      ctypes.byref(self.handle))
        if rc != 0 or not self.handle.value:
            raise RuntimeError(f"silero_vad_open rc={rc}")

    def reset(self) -> None:
        self.lib.silero_vad_reset_state(self.handle)

    def process(self, window: np.ndarray) -> float:
        if window.shape != (WINDOW_SAMPLES,) or window.dtype != np.float32:
            raise ValueError(f"window must be float32 (512,), got {window.dtype} {window.shape}")
        prob = ctypes.c_float(0.0)
        buf = window.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        rc = self.lib.silero_vad_process(self.handle, buf, WINDOW_SAMPLES, ctypes.byref(prob))
        if rc != 0:
            raise RuntimeError(f"silero_vad_process rc={rc}")
        return prob.value

    def backend(self) -> str:
        return self.lib.silero_vad_active_backend().decode("utf-8")

    def close(self) -> None:
        if getattr(self, "handle", None) and self.handle.value:
            self.lib.silero_vad_close(self.handle)
            self.handle = ctypes.c_void_p()


# ── Reference (silero-vad ONNX) ───────────────────────────────────────────

class OnnxReference:
    def __init__(self) -> None:
        try:
            import onnxruntime as ort
            from silero_vad import load_silero_vad as _load
            from silero_vad.utils_vad import OnnxWrapper
        except ImportError as e:  # pragma: no cover
            raise SystemExit(
                "[parity] reference path requires `pip install silero-vad onnxruntime` "
                f"({e}). The parity test cannot meaningfully run without the upstream "
                "ONNX session — it would be checking the C runtime against itself."
            )
        # Use the ONNX path via silero_vad's loader (it ships the ONNX bundle)
        # but talk to it as a plain ORT session so we can drive (state, sr, audio)
        # explicitly.
        self.model = _load(onnx=True)
        # OnnxWrapper exposes the underlying session; use it directly so we can
        # inject the same state every call and avoid any internal post-processing.
        if hasattr(self.model, "session"):
            self.session = self.model.session
        else:
            # Fallback: silero-vad bundles the .onnx; locate it on disk.
            import silero_vad as _sv
            onnx_path = Path(_sv.__file__).parent / "data" / "silero_vad.onnx"
            self.session = ort.InferenceSession(
                str(onnx_path), providers=["CPUExecutionProvider"]
            )
        self.state = np.zeros((2, 1, 128), dtype=np.float32)

    def reset(self) -> None:
        self.state = np.zeros((2, 1, 128), dtype=np.float32)

    def process(self, window: np.ndarray) -> float:
        if window.shape != (WINDOW_SAMPLES,) or window.dtype != np.float32:
            raise ValueError(f"window must be float32 (512,), got {window.dtype} {window.shape}")
        out, state_n = self.session.run(
            None,
            {
                "input": window.reshape(1, -1).astype(np.float32),
                "state": self.state,
                "sr": np.array(SAMPLE_RATE_HZ, dtype=np.int64),
            },
        )
        self.state = state_n
        return float(out.reshape(-1)[0])


# ── Fixture: 5 s mixed speech/silence ─────────────────────────────────────

def make_fixture() -> np.ndarray:
    """Deterministic 5 s, 16 kHz mono fixture composed of:
       - 1 s silence
       - 2 s amplitude-modulated band-noise around 250 Hz (speech-ish)
       - 1 s silence
       - 1 s pure 800 Hz tone
    The exact contents don't matter — what matters is that the C and
    ONNX runtimes track each other window-by-window across a varied
    signal. Both backends start with zero state. """
    rng = np.random.default_rng(0xCAFE)
    n_total = 5 * SAMPLE_RATE_HZ
    out = np.zeros(n_total, dtype=np.float32)
    t = np.arange(n_total) / SAMPLE_RATE_HZ
    # Segment 1: silence (already zero).
    # Segment 2: speech-like noise.
    s2 = slice(1 * SAMPLE_RATE_HZ, 3 * SAMPLE_RATE_HZ)
    carrier = np.sin(2 * np.pi * 250.0 * t[s2])
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 5.0 * t[s2])
    noise = rng.standard_normal(s2.stop - s2.start).astype(np.float32) * 0.2
    out[s2] = (0.4 * envelope * (0.7 * carrier + 0.3 * noise)).astype(np.float32)
    # Segment 3: silence (already zero).
    # Segment 4: pure tone.
    s4 = slice(4 * SAMPLE_RATE_HZ, 5 * SAMPLE_RATE_HZ)
    out[s4] = (0.3 * np.sin(2 * np.pi * 800.0 * t[s4])).astype(np.float32)
    return out


def per_window_probs(runtime, audio: np.ndarray) -> List[float]:
    runtime.reset()
    n_windows = len(audio) // WINDOW_SAMPLES
    probs: List[float] = []
    for i in range(n_windows):
        win = audio[i * WINDOW_SAMPLES : (i + 1) * WINDOW_SAMPLES].astype(np.float32)
        probs.append(runtime.process(win))
    return probs


# ── Driver ───────────────────────────────────────────────────────────────

def main() -> int:
    here = Path(__file__).resolve()
    repo_root = here.parents[4]
    default_lib = repo_root / "packages" / "native-plugins" / "silero-vad-cpp" / "build" / "libsilero_vad.so"
    default_gguf = repo_root / "packages" / "native-plugins" / "silero-vad-cpp" / "build" / "silero-vad-v5.gguf"

    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument("--library", type=Path, default=default_lib,
                   help=f"Path to libsilero_vad.{{so,dylib,dll}} (default: {default_lib})")
    p.add_argument("--gguf", type=Path, default=default_gguf,
                   help=f"Path to silero-vad-v5.gguf (default: {default_gguf})")
    p.add_argument("--tolerance", type=float, default=PARITY_TOLERANCE,
                   help=f"Per-window absolute tolerance (default: {PARITY_TOLERANCE})")
    args = p.parse_args()

    print(f"[parity] library = {args.library}")
    print(f"[parity] gguf    = {args.gguf}")
    print(f"[parity] tolerance = ±{args.tolerance}")

    try:
        c_rt = CRuntime(args.library, args.gguf)
    except (FileNotFoundError, RuntimeError) as e:
        print(f"[parity] FAIL: cannot load C runtime: {e}", file=sys.stderr)
        return 2

    try:
        ref = OnnxReference()
    except SystemExit:
        c_rt.close()
        raise

    print(f"[parity] C runtime backend  = {c_rt.backend()}")

    audio = make_fixture()
    print(f"[parity] fixture           = {len(audio)} samples = {len(audio) // WINDOW_SAMPLES} windows")

    c_probs   = per_window_probs(c_rt, audio)
    ref_probs = per_window_probs(ref, audio)

    n = min(len(c_probs), len(ref_probs))
    diffs = np.abs(np.array(c_probs[:n]) - np.array(ref_probs[:n]))
    max_diff = float(diffs.max())
    mean_diff = float(diffs.mean())
    p95_diff = float(np.percentile(diffs, 95))
    fails = [(i, c_probs[i], ref_probs[i], float(diffs[i])) for i in range(n) if diffs[i] > args.tolerance]

    print(f"[parity] mean diff = {mean_diff:.5f}")
    print(f"[parity] p95 diff  = {p95_diff:.5f}")
    print(f"[parity] max diff  = {max_diff:.5f}")
    print(f"[parity] failing windows (> {args.tolerance}): {len(fails)} / {n}")

    if fails:
        for i, c, r, d in fails[:10]:
            print(f"  [{i:4d}] c={c:.5f} ref={r:.5f} diff={d:.5f}")
        if len(fails) > 10:
            print(f"  ... and {len(fails) - 10} more")

    c_rt.close()
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
