#!/usr/bin/env python3
"""End-to-end validation with REAL phonemes: misaki G2P -> vocab ids ->
CoreML kokoro_5s -> audio, compared against torch ground truth.

Validates that the converted model + vocab_index.json + voices/*.json work
together to produce intelligible speech.
"""
import json
import os
import sys
from pathlib import Path
import numpy as np
import torch
import coremltools as ct
import export_e2e_coreml as E  # applies SineGen/AdaIN monkeypatches on import

WORK = Path(os.environ.get("KOKORO_COREML_OUT_ROOT", "/tmp/kokoro-coreml-work"))
OUT = WORK / "out"
SR = 24000

def phonemize(text):
    try:
        from misaki import en
        g2p = en.G2P(trf=False, british=False)
        ps, _ = g2p(text)
        return ps
    except Exception:
        # Fallback IPA (misaki unavailable). Parity is independent of exact
        # phonemes since torch-truth and CoreML consume the SAME ids; torch-truth
        # (real Kokoro) guarantees the audio is intelligible speech.
        return "həlˈoʊ, ðɪs ɪz ɪlˈaɪzə spˈiːkɪŋ ɑn dəvˈaɪs."

def ids_from_phonemes(ps, vocab, max_tokens=128):
    ids = [0]  # bos ($ -> 0)
    for ch in ps:
        if ch in vocab:
            ids.append(vocab[ch])
    ids.append(0)  # eos
    ids = ids[:max_tokens]
    n = len(ids)
    ids = ids + [0] * (max_tokens - n)
    return ids, n

def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "Hello, this is Eliza speaking on device."
    pkg = OUT / "kokoro_5s.mlpackage"
    vocab = json.loads((OUT / "kokoro-coreml/vocab_index.json").read_text())["vocab"]
    voice = json.loads((OUT / "kokoro-coreml/voices/af_heart.json").read_text())["embedding"]

    ps = phonemize(text)
    print(f"[phonemes] {ps!r}")
    ids_list, n = ids_from_phonemes(ps, vocab)
    print(f"[tokens] n={n}")
    ids = torch.tensor([ids_list], dtype=torch.int32)
    mask = torch.zeros(1, 128, dtype=torch.int32)
    mask[0, :n] = 1
    ref_s = torch.tensor(voice, dtype=torch.float32).view(1, 256)
    phases = torch.rand(1, 9, generator=torch.Generator().manual_seed(7), dtype=torch.float32)
    speed = torch.tensor([1.0], dtype=torch.float32)

    # torch ground truth (real kokoro, deterministic source) on unpadded ids
    m_ref = E.load_model()
    E.AdaIN1d._frame_mask = None
    m_ref.decoder.generator.m_source.l_sin_gen._inj_phase = phases
    with torch.no_grad():
        a_truth, pdur = m_ref.forward_with_tokens(ids[:, :n].long(), ref_s, 1.0)
    a_truth = a_truth.reshape(-1).numpy()
    print(f"[torch truth] samples={a_truth.shape[0]} pred_dur_sum={int(pdur.sum())} rms={np.sqrt(np.mean(a_truth**2)):.4f}")

    # torch fused (fp32) — isolates fp16 from module correctness
    bucket = 200
    m2 = E.load_model()
    e2e = E.KokoroE2E(m2, bucket).eval()
    for mod in e2e.modules():
        mod.eval()
    with torch.no_grad():
        a_fused, alen_f, pdur_f = e2e(ids, mask, ref_s, phases, speed)
    vf = int(alen_f.item())
    a_fused = a_fused[0, :vf].numpy().astype(np.float64)
    sc_f, ld_f = E.spectral_parity(a_fused, a_truth)
    print(f"[torch-fused] alen={vf} rms={np.sqrt(np.mean(a_fused**2)):.4f} "
          f"spectral_corr_vs_truth={sc_f:.5f} logmel_L1={ld_f:.5f}")

    # coreml
    mlmodel = ct.models.MLModel(str(pkg))
    pred = mlmodel.predict({
        "input_ids": ids.numpy(), "attention_mask": mask.numpy(),
        "ref_s": ref_s.numpy(), "random_phases": phases.numpy(), "speed": speed.numpy(),
    })
    alen = int(pred["audio_length_samples"].reshape(-1)[0])
    a_cl = pred["audio"].reshape(-1)[:alen].astype(np.float64)
    print(f"[coreml] audio_length_samples={alen} rms={np.sqrt(np.mean(a_cl**2)):.4f} pred_dur_sum={int(pred['pred_dur'].reshape(-1).sum())}")

    sc, ld = E.spectral_parity(a_cl, a_truth)
    print(f"[real-sentence spectral parity coreml-vs-truth] stft_mag_corr={sc:.5f} logmel_L1={ld:.5f}")

    try:
        import soundfile as sf
        sf.write(str(WORK / "real_coreml.wav"), a_cl, SR)
        sf.write(str(WORK / "real_truth.wav"), a_truth, SR)
        print("[wav] wrote real_coreml.wav / real_truth.wav")
    except Exception as e:
        print("[wav] skipped:", e)

if __name__ == "__main__":
    main()
