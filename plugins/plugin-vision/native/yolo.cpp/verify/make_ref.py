#!/usr/bin/env python3
"""
Build a fixed preprocessed input + an ultralytics reference output, so the ggml
runtime can be checked numerically against PyTorch on the SAME input bytes.

Writes (next to this script):
  input.bin  float32 CHW [3,640,640], RGB /255, letterboxed (gray 114) — fed to BOTH
  ref.bin    float32 [84,8400] ultralytics DetectionModel output (cx,cy,w,h px + sigmoid cls)
  meta.txt   shapes + a few top reference detections for human sanity
"""
import os
import sys

import numpy as np
import torch
from PIL import Image
from ultralytics import YOLO
from ultralytics.utils import ASSETS

HERE = os.path.dirname(os.path.abspath(__file__))
INSIZE = 640


def letterbox_chw(img: Image.Image) -> np.ndarray:
    w, h = img.size
    scale = min(INSIZE / w, INSIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (INSIZE, INSIZE), (114, 114, 114))
    padw = round((INSIZE - nw) / 2)
    padh = round((INSIZE - nh) / 2)
    canvas.paste(resized, (padw, padh))
    arr = np.asarray(canvas).astype(np.float32) / 255.0  # HWC RGB
    chw = np.ascontiguousarray(np.transpose(arr, (2, 0, 1)))  # CHW
    return chw


def main() -> int:
    src = ASSETS / "bus.jpg"
    img = Image.open(src).convert("RGB")
    # stage the test image next to this script for run_ts.mjs (gitignored).
    img.save(os.path.join(HERE, "bus.jpg"))
    chw = letterbox_chw(img)
    chw.tofile(os.path.join(HERE, "input.bin"))

    model = YOLO("yolov8n.pt").model.eval().float()
    with torch.no_grad():
        inp = torch.from_numpy(chw[None])  # [1,3,640,640]
        out = model(inp)
        if isinstance(out, (list, tuple)):
            out = out[0]
        preds = out[0].cpu().numpy().astype(np.float32)  # [84,8400]
    preds.tofile(os.path.join(HERE, "ref.bin"))

    # human sanity: decode top reference detections (no NMS, just peek)
    boxes = preds[:4]          # [4,8400]
    scores = preds[4:]         # [80,8400]
    cls = scores.argmax(0)
    conf = scores.max(0)
    order = conf.argsort()[::-1][:8]
    lines = [f"input.bin CHW [3,{INSIZE},{INSIZE}]", f"ref.bin [84,8400] from {src.name}"]
    for a in order:
        cx, cy, bw, bh = boxes[:, a]
        lines.append(
            f"  anchor {a:5d} cls={cls[a]:2d} conf={conf[a]:.3f} "
            f"box(cx,cy,w,h)=({cx:.1f},{cy:.1f},{bw:.1f},{bh:.1f})"
        )
    meta = "\n".join(lines)
    open(os.path.join(HERE, "meta.txt"), "w").write(meta + "\n")
    print(meta)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
