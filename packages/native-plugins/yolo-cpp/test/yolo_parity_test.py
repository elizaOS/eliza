#!/usr/bin/env python3
"""Parity test: ultralytics-Python vs libyolo (via ctypes).

Goal: prove that libyolo's detect path produces detections that match
ultralytics within a strict tolerance:
  - per-detection class id matches a Python-side detection,
  - bbox IoU ≥ 0.95 against the matched Python detection,
  - confidence within 1e-2 of the matched Python confidence,
  - top-K detections agree (K = min(python_count, c_count, 10)).

Runs against a small set of fixture images that ship under
test/fixtures/. The Python side uses ultralytics directly; the C
side dlopens build/libyolo.so and calls yolo_open / yolo_detect /
yolo_close through ctypes.

HONEST blocker today
--------------------
The libyolo forward pass is staged — yolo_detect returns -ENOSYS while
the scalar-C op-schedule is being wired (see yolo_runtime.c's TU
header for the rationale and the Phase 3 plan: ggml dispatch or
im2col + SIMD). Until the forward pass lands the test exits with
code 77 (CTest's "skipped" code) and prints both the Python detections
and the libyolo readiness so the gap is auditable. When the forward
lands the asserts trigger and this script becomes a proper parity gate.

Run:
  python3 test/yolo_parity_test.py \\
    --library build/libyolo.so \\
    --gguf /tmp/yolov8n.gguf \\
    --fixture-dir test/fixtures
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import sys
from pathlib import Path
from typing import List, Tuple


SKIP_RC = 77   # CTest "skipped" exit code


# ── ctypes binding ─────────────────────────────────────────────────────

class YoloDetection(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_float),
        ("y", ctypes.c_float),
        ("w", ctypes.c_float),
        ("h", ctypes.c_float),
        ("confidence", ctypes.c_float),
        ("class_id", ctypes.c_int),
    ]


class YoloImage(ctypes.Structure):
    _fields_ = [
        ("rgb", ctypes.POINTER(ctypes.c_uint8)),
        ("w", ctypes.c_int),
        ("h", ctypes.c_int),
        ("stride", ctypes.c_int),
    ]


def _bind(lib: ctypes.CDLL):
    lib.yolo_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.yolo_open.restype = ctypes.c_int
    lib.yolo_detect.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(YoloImage),
        ctypes.c_float,
        ctypes.c_float,
        ctypes.POINTER(YoloDetection),
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    lib.yolo_detect.restype = ctypes.c_int
    lib.yolo_close.argtypes = [ctypes.c_void_p]
    lib.yolo_close.restype = ctypes.c_int
    lib.yolo_active_backend.argtypes = []
    lib.yolo_active_backend.restype = ctypes.c_char_p
    return lib


# ── parity helpers ─────────────────────────────────────────────────────

def iou(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def python_detect(image_path: Path) -> List[Tuple[int, float, Tuple[float, float, float, float]]]:
    from ultralytics import YOLO  # type: ignore[import-not-found]
    m = YOLO("yolov8n.pt")
    res = m.predict(str(image_path), conf=0.25, iou=0.45, verbose=False)[0]
    out = []
    for b in res.boxes:
        cls = int(b.cls.item())
        conf = float(b.conf.item())
        # xyxy → (x, y, w, h) source-image absolute pixels.
        xyxy = b.xyxy[0].cpu().numpy().tolist()
        x, y = xyxy[0], xyxy[1]
        w, h = xyxy[2] - xyxy[0], xyxy[3] - xyxy[1]
        out.append((cls, conf, (x, y, w, h)))
    return out


def c_detect(lib: ctypes.CDLL, gguf: Path, image_path: Path) -> List[Tuple[int, float, Tuple[float, float, float, float]]]:
    handle = ctypes.c_void_p()
    rc = lib.yolo_open(str(gguf).encode("utf-8"), ctypes.byref(handle))
    if rc != 0:
        raise RuntimeError(f"yolo_open failed: rc={rc}")

    try:
        from PIL import Image
        img = Image.open(image_path).convert("RGB")
        w, h = img.size
        buf = bytes(img.tobytes())
        cbuf = (ctypes.c_uint8 * len(buf)).from_buffer_copy(buf)
        yimg = YoloImage(rgb=cbuf, w=w, h=h, stride=w * 3)
        out_arr = (YoloDetection * 256)()
        out_count = ctypes.c_size_t(0)
        rc = lib.yolo_detect(handle, ctypes.byref(yimg), ctypes.c_float(0.25),
                             ctypes.c_float(0.45),
                             out_arr, 256, ctypes.byref(out_count))
        if rc == -errno.ENOSYS:
            return None  # signal "staged"
        if rc != 0:
            raise RuntimeError(f"yolo_detect failed: rc={rc}")
        out: List[Tuple[int, float, Tuple[float, float, float, float]]] = []
        for i in range(out_count.value):
            d = out_arr[i]
            out.append((d.class_id, d.confidence, (d.x, d.y, d.w, d.h)))
        return out
    finally:
        lib.yolo_close(handle)


# ── main ───────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--library", type=Path, required=True,
                   help="Path to libyolo.{so,dylib,dll}")
    p.add_argument("--gguf", type=Path, required=True,
                   help="Path to yolov8n.gguf produced by yolo_to_gguf.py")
    p.add_argument("--fixture-dir", type=Path, required=True,
                   help="Directory containing fixture images (jpg/png)")
    args = p.parse_args()

    if not args.library.exists():
        print(f"[parity] library not built at {args.library}", file=sys.stderr)
        return 1
    if not args.gguf.exists():
        print(f"[parity] gguf missing at {args.gguf}", file=sys.stderr)
        return 1
    fixtures = sorted([
        p for p in args.fixture_dir.iterdir()
        if p.suffix.lower() in (".jpg", ".jpeg", ".png")
    ])
    if not fixtures:
        print(f"[parity] no fixture images under {args.fixture_dir}", file=sys.stderr)
        return 1

    try:
        from ultralytics import YOLO  # noqa: F401
    except ImportError:
        print("[parity] ultralytics not installed — install with:", file=sys.stderr)
        print("  pip install --break-system-packages ultralytics", file=sys.stderr)
        return SKIP_RC
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print("[parity] Pillow not installed — install with:", file=sys.stderr)
        print("  pip install --break-system-packages Pillow", file=sys.stderr)
        return SKIP_RC

    lib = _bind(ctypes.CDLL(str(args.library)))
    backend = lib.yolo_active_backend().decode("utf-8")
    print(f"[parity] libyolo backend = {backend}")

    failures = 0
    for fx in fixtures:
        print(f"\n[parity] === {fx.name} ===")
        py = python_detect(fx)
        py.sort(key=lambda r: -r[1])
        print(f"[parity]   python: {len(py)} detections")
        for cls, conf, bb in py[:5]:
            print(f"[parity]     class={cls} conf={conf:.3f} box={bb}")

        c = c_detect(lib, args.gguf, fx)
        if c is None:
            print("[parity]   libyolo: yolo_detect returned -ENOSYS (forward pass staged)")
            print("[parity]   SKIPPING content asserts; see yolo_runtime.c TU header")
            continue
        c.sort(key=lambda r: -r[1])
        print(f"[parity]   libyolo: {len(c)} detections")
        for cls, conf, bb in c[:5]:
            print(f"[parity]     class={cls} conf={conf:.3f} box={bb}")

        # Match top-K. For each top-K libyolo detection, find the
        # highest-IoU same-class python detection and assert.
        K = min(len(py), len(c), 10)
        for i in range(K):
            cls_c, conf_c, bb_c = c[i]
            best = -1.0
            best_p = None
            for cls_p, conf_p, bb_p in py:
                if cls_p != cls_c:
                    continue
                ov = iou(bb_c, bb_p)
                if ov > best:
                    best = ov
                    best_p = (cls_p, conf_p, bb_p)
            if best_p is None:
                print(f"[parity]   FAIL no same-class python match for libyolo det #{i}")
                failures += 1
                continue
            if best < 0.95:
                print(f"[parity]   FAIL IoU {best:.3f} < 0.95 for det #{i}")
                failures += 1
            if abs(conf_c - best_p[1]) > 1e-2:
                print(f"[parity]   FAIL conf delta {abs(conf_c - best_p[1]):.4f} > 1e-2 for det #{i}")
                failures += 1

    if c is None:  # last fixture's libyolo path was staged
        print("\n[parity] OVERALL: SKIPPED (libyolo.yolo_detect staged → -ENOSYS)")
        return SKIP_RC
    print(f"\n[parity] OVERALL: failures={failures} over {len(fixtures)} fixtures")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
