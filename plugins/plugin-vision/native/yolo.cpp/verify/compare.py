#!/usr/bin/env python3
"""Compare verify/out.bin (ggml) against verify/ref.bin (ultralytics)."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

COCO = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
    "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
    "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table",
    "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock",
    "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]


def nms(boxes, scores, iou_thr=0.5):
    # boxes xywh -> xyxy
    x1 = boxes[:, 0] - boxes[:, 2] / 2
    y1 = boxes[:, 1] - boxes[:, 3] / 2
    x2 = boxes[:, 0] + boxes[:, 2] / 2
    y2 = boxes[:, 1] + boxes[:, 3] / 2
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


def detect(preds, conf_thr=0.25):
    boxes = preds[:4].T          # [8400,4]
    scores = preds[4:]           # [80,8400]
    cls = scores.argmax(0)
    conf = scores.max(0)
    m = conf >= conf_thr
    b, c, s = boxes[m], cls[m], conf[m]
    keep = nms(b, s)
    return [(int(c[k]), float(s[k]), b[k]) for k in keep]


def main() -> int:
    ref = np.fromfile(os.path.join(HERE, "ref.bin"), dtype=np.float32)
    out = np.fromfile(os.path.join(HERE, "out.bin"), dtype=np.float32)
    if ref.size != 84 * 8400 or out.size != 84 * 8400:
        print(f"size mismatch ref={ref.size} out={out.size}", file=sys.stderr)
        return 1
    ref = ref.reshape(84, 8400)
    out = out.reshape(84, 8400)

    box_diff = np.abs(ref[:4] - out[:4])
    cls_diff = np.abs(ref[4:] - out[4:])
    print(f"box  max|Δ|={box_diff.max():.4f} mean|Δ|={box_diff.mean():.5f}")
    print(f"cls  max|Δ|={cls_diff.max():.5f} mean|Δ|={cls_diff.mean():.6f}")

    print("\n-- ultralytics reference detections --")
    rd = detect(ref)
    for c, s, b in rd:
        print(f"  {COCO[c]:12s} {s:.3f} xywh=({b[0]:.0f},{b[1]:.0f},{b[2]:.0f},{b[3]:.0f})")
    print("-- ggml detections --")
    gd = detect(out)
    for c, s, b in gd:
        print(f"  {COCO[c]:12s} {s:.3f} xywh=({b[0]:.0f},{b[1]:.0f},{b[2]:.0f},{b[3]:.0f})")

    # pass criteria: same set of (class) detections, boxes within a few px, scores close
    ref_set = sorted([(c, round(float(s), 1)) for c, s, _ in rd])
    gd_set = sorted([(c, round(float(s), 1)) for c, s, _ in gd])
    ok = (
        box_diff.max() < 2.0
        and cls_diff.max() < 0.02
        and len(rd) == len(gd)
        and [c for c, _, _ in rd] == [c for c, _, _ in gd]
    )
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'}  "
          f"(ref {len(rd)} dets, ggml {len(gd)} dets)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
