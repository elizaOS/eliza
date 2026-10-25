#!/usr/bin/env bash
# packages/training/scripts/voice/audit_same.sh
# Pre-flight gate for the same voice corpus. Exits non-zero if any
# check fails. Run before invoking the kokoro pipeline (I7).
#
# Audits the upstream `sam/` clone slice from lalalune/ai_voices —
# the corpus is canonically renamed to `same` once landed locally via
# build_same_manifest.py, but the upstream subset directory is still
# `sam` (we don't control upstream naming).
#
# Usage:
#   ./audit_same.sh                            # audits /tmp/ai_voices/sam
#   ./audit_same.sh /path/to/sam     # audits an alternate clone
#
# Verifies:
#   1. 58 wav + 58 txt files, no extras.
#   2. Every wav has a matching non-empty txt.
#   3. Every clip is 44.1 kHz mono 16-bit PCM.
#   4. Every clip duration in [0.5, 15] s; total in [180, 240] s.
#   5. Warns if `samantha_002.txt` still holds the Whisper-base
#      hallucination '641.' (R12 §3.5). Non-fatal — pass through
#      build_same_manifest.py with whisper-large-v3 to fix.

set -euo pipefail

ROOT="${1:-/tmp/ai_voices/sam}"

if [[ ! -d "$ROOT" ]]; then
  echo "FAIL: upstream sam source not found at $ROOT" >&2
  echo "      run: python3 packages/training/scripts/voice/build_same_manifest.py --sparse-clone /tmp/ai_voices" >&2
  exit 1
fi

# 1. Pair count: 58 wav + 58 txt, no extras.
WAV=$(find "$ROOT" -maxdepth 1 -name '*.wav' | wc -l)
TXT=$(find "$ROOT" -maxdepth 1 -name '*.txt' | wc -l)
[[ "$WAV" -eq 58 ]] || { echo "FAIL: expected 58 wavs, got $WAV"; exit 1; }
[[ "$TXT" -eq 58 ]] || { echo "FAIL: expected 58 txts, got $TXT"; exit 1; }

# 2. Pair completeness.
for w in "$ROOT"/*.wav; do
  t="${w%.wav}.txt"
  [[ -f "$t" ]] || { echo "FAIL: missing txt for $w"; exit 1; }
  [[ -s "$t" ]] || { echo "FAIL: empty transcript $t"; exit 1; }
done

# 3. Audio format — all clips 44.1 kHz mono 16-bit PCM.
python3 - "$ROOT" <<'PY'
import sys, glob, wave
root = sys.argv[1]
bad = []
for p in sorted(glob.glob(root + "/*.wav")):
    with wave.open(p, "rb") as w:
        triple = (w.getframerate(), w.getnchannels(), w.getsampwidth())
        if triple != (44100, 1, 2):
            bad.append((p, triple[0], triple[1], triple[2] * 8))
if bad:
    for b in bad:
        print("FAIL audio format:", b)
    sys.exit(1)
PY

# 4. Duration: every clip in [0.5, 15] s; total in [180, 240] s.
python3 - "$ROOT" <<'PY'
import sys, glob, wave
root = sys.argv[1]
total = 0.0
for p in sorted(glob.glob(root + "/*.wav")):
    with wave.open(p, "rb") as w:
        d = w.getnframes() / w.getframerate()
    if not (0.5 <= d <= 15.0):
        print(f"FAIL clip out of range: {p} {d:.2f}s")
        sys.exit(1)
    total += d
if not (180 <= total <= 240):
    print(f"FAIL total duration drifted: {total:.1f}s")
    sys.exit(1)
print(f"OK total {total:.1f}s")
PY

# 5. Known Whisper-base hallucination — warn only.
if grep -q "^641\.$" "$ROOT/samantha_002.txt" 2>/dev/null; then
  echo "WARN: samantha_002.txt still has the '641.' hallucination — re-transcribe with whisper-large-v3 (run build_same_manifest.py without --no-retranscribe)."
fi

echo "OK: same corpus passes pre-flight."
