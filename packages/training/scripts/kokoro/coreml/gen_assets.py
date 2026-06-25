#!/usr/bin/env python3
"""Generate vocab_index.json + voices/*.json for the CoreML Kokoro bundle.

vocab_index.json : {"vocab": {ipa_symbol: id}}  (KokoroPhonemizer.loadVocab)
voices/<id>.json : {"embedding": [256 floats]}   (KokoroCoreMlEngine.loadVoiceEmbeddings)

Voice embedding = mean of the first N ref_s rows of the Kokoro voice pack
([510,1,256]); a single stable speaker vector since the Swift engine uses one
fixed ref_s per voice across all chunk lengths.
"""
import json
import os
import sys
from pathlib import Path
import torch

REF = Path(os.environ.get("KOKORO_COREML_REF", "/tmp/kokoro-coreml-work/ref"))
HEX = Path(os.environ.get("KOKORO_COREML_HEXGRAD", "/tmp/kokoro-coreml-work/hexgrad"))
STYLE_DIM = 256
N_AVG = 64

def main(out_dir):
    out = Path(out_dir)
    (out / "voices").mkdir(parents=True, exist_ok=True)
    cfg = json.loads((REF / "checkpoints/config.json").read_text())
    vocab = cfg["vocab"]
    (out / "vocab_index.json").write_text(json.dumps({"vocab": vocab}, ensure_ascii=False))
    print(f"[vocab] {len(vocab)} symbols -> {out/'vocab_index.json'}")

    voices_dir = HEX / "voices"
    n = 0
    for pt in sorted(voices_dir.glob("*.pt")):
        vp = torch.load(pt, map_location="cpu")  # [510,1,256]
        emb = vp[:N_AVG].reshape(N_AVG, -1)[:, :STYLE_DIM].mean(0).float().tolist()
        (out / "voices" / f"{pt.stem}.json").write_text(json.dumps({"embedding": emb}))
        n += 1
    print(f"[voices] wrote {n} voice json files -> {out/'voices'}")
    assert (out / "voices" / "af_heart.json").exists(), "af_heart.json required by KokoroCoreMlEngine"
    print("[ok] af_heart.json present")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/kokoro-coreml-work/out/kokoro-coreml")
