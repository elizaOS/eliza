#!/usr/bin/env python3
"""analyze-prefill.py — #11734 leg 1b definitive prefill isolation.

Uses the device's own per-turn work window W = producedTok / tokS from the
`GENERATE_STREAM done` logcat lines. W spans resetAndPrefillResident(prompt)
+ the full 256-token decode and EXCLUDES model load (ensureResidentCtx runs
before the timed window) and lock queue-wait — verified against an unqueued
turn's from→done wall (54038 ms vs 54008 ms).

Fits W = W0 + m * promptTokens over the 8-rung v3 ladder (fresh-boot rungs,
each pre-warmed by the app's boot self-test generation) plus the leg-1a warm
anchor. promptTokens from the Qwen3.5 tokenizer (exact, add_bos=false).
"""

import json
import gzip
import re
import statistics
from datetime import datetime

RAW = "/home/shaw/eliza-worktrees/bench-11734/.github/issue-evidence/11734-pixel6a-adb-rows/raw"

# promptChars -> exact Qwen3.5 prompt tokens (analysis/prompt-tokens.json ladder)
LADDER = {294: 92, 384: 110, 471: 127, 561: 146, 648: 164, 743: 182, 834: 201, 919: 219}
V3_WINDOW = ("06:42:30", "07:09:00")  # v3 sweep logcat window


def _open_logcat():
    """Open the session logcat, transparently handling the gzipped archive."""
    import os
    plain = f"{RAW}/session-logcat.log"
    if os.path.exists(plain):
        return open(plain, errors="replace")
    return gzip.open(f"{plain}.gz", "rt", errors="replace")

def main():
    turns = []
    pending = {}  # tid -> (ts, chars)
    for line in _open_logcat():
        if "ElizaBionicInfer" not in line:
            continue
        m = re.match(r"\d\d-\d\d (\d\d:\d\d:\d\d)\.\d+\s+\d+\s+(\d+)", line)
        if not m:
            continue
        hms, tid = m.group(1), int(m.group(2))
        if "GENERATE_STREAM from agent" in line:
            mm = re.search(r"(\d+) prompt chars, maxTokens=20", line)
            if mm:
                pending[tid] = (hms, int(mm.group(1)))
        elif "GENERATE_STREAM done" in line and tid in pending:
            mm = re.search(r"(\d+) tok @ ([\d.]+) tok/s", line)
            start_hms, chars = pending.pop(tid)
            turns.append({
                "start": start_hms, "done": hms, "promptChars": chars,
                "produced": int(mm.group(1)), "tokS": float(mm.group(2)),
                "workS": round(int(mm.group(1)) / float(mm.group(2)), 2),
            })
    v3 = [t for t in turns
          if V3_WINDOW[0] <= t["start"] <= V3_WINDOW[1] and t["promptChars"] in LADDER]
    print("v3 ladder (fresh-boot rungs, pre-warmed by boot self-test):")
    print(f"{'promptChars':>12} {'P(tok)':>7} {'tokS':>6} {'W(s)':>7}  start->done")
    pts = []
    for t in sorted(v3, key=lambda t: t["promptChars"]):
        p = LADDER[t["promptChars"]]
        pts.append((p, t["workS"]))
        print(f"{t['promptChars']:>12} {p:>7} {t['tokS']:>6} {t['workS']:>7}  {t['start']} -> {t['done']}")

    # leg 1a warm anchor (same-process, back-to-back; median of 9 warm turns)
    leg1a_warm = [t for t in turns if "06:00:00" <= t["start"] <= "06:16:00"
                  and t["promptChars"] == 294 and t["tokS"] >= 4.6]
    anchor = statistics.median(t["workS"] for t in leg1a_warm)
    print(f"\nleg-1a warm anchor: P=92, W median={anchor}s over n={len(leg1a_warm)} turns")

    n = len(pts)
    sx = sum(p for p, _ in pts); sy = sum(w for _, w in pts)
    sxx = sum(p * p for p, _ in pts); sxy = sum(p * w for p, w in pts)
    m_ = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    w0 = (sy - m_ * sx) / n
    ybar = sy / n
    ssr = sum((w - (w0 + m_ * p)) ** 2 for p, w in pts)
    sst = sum((w - ybar) ** 2 for _, w in pts)
    r2 = 1 - ssr / sst
    print(f"\nlinear fit over v3 ladder: W = {w0:.1f}s + {m_:.4f} s/tok * P   (r^2={r2:.3f})")
    print(f"  -> marginal PREFILL rate = {1 / m_:.2f} tok/s (dispatch-quantized, see step shape)")
    print(f"  -> intercept {w0:.1f}s for the constant 256-tok decode -> effective DECODE <= {256 / w0:.2f} tok/s")
    lo = [w for p, w in pts if p <= 127] + [anchor]
    hi = [w for p, w in pts if p >= 201]
    print(f"  step view: P<=127 flat at {statistics.mean(lo):.1f}s (n={len(lo)});"
          f" P>=201 at {statistics.mean(hi):.1f}s (n={len(hi)});"
          f" delta {statistics.mean(hi) - statistics.mean(lo):.1f}s over ~92 tok"
          f" -> {92 / (statistics.mean(hi) - statistics.mean(lo)):.1f} tok/s in the transition")
    json.dump({"v3Ladder": v3, "leg1aWarmAnchorS": anchor,
               "fit": {"interceptS": round(w0, 2), "slopeSPerTok": round(m_, 5), "r2": round(r2, 4),
                        "marginalPrefillTokS": round(1 / m_, 2), "effectiveDecodeTokSUpperBound": round(256 / w0, 2)}},
              open(f"{RAW}/../analysis/prefill-fit.json", "w"), indent=1)
    print("\nanalysis/prefill-fit.json written")

if __name__ == "__main__":
    main()
