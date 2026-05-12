#!/usr/bin/env python3
"""Train the Eliza-1 wake-word head on the default wake phrase ("hey eliza").

This is the runnable recipe behind
`packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md`. It
implements the openWakeWord (Apache-2.0, https://github.com/dscripka/openWakeWord)
training pipeline: a small dense head on top of the frozen, model-agnostic
`melspectrogram.onnx` → `embedding_model.onnx` front-end. Only the head changes
per wake phrase; the two front-end graphs ship verbatim.

Default wake phrase: **"hey eliza"** — a two-word, four-syllable phrase the
openWakeWord TTS-augmented pipeline handles well. It is the documented default;
it is replaceable (pass `--phrase "..."`). Until a head trained by this script
ships in bundles, `wake/hey-eliza.onnx` is the upstream `hey_jarvis` head
renamed and the runtime marks it a placeholder
(`OPENWAKEWORD_PLACEHOLDER_HEADS` in
`packages/app-core/src/services/local-inference/voice/wake-word.ts`).

Pipeline (each step is a function below; `--help` lists the flags):

  1. Positives — `--positives-dir` of `*.wav` (16 kHz mono) of the phrase
     across many voices/speeds/pitches. openWakeWord's notebook expects
     ~30k–50k positives for a robust head; synthesize them with a
     permissively-licensed TTS (`piper` + the piper-sample-generator, or
     `espeak-ng`). The `synthesize_positives_*` helpers wrap piper / espeak
     when they're on PATH; otherwise stage the dir yourself.
  2. Negatives — `--negatives-dir` of `*.wav` of speech/ambient that does NOT
     contain the phrase (ACAV100M / FMA / Common Voice + room-impulse + noise
     augmentation, the same `audiomentations` chain the notebook uses).
  3. Features — every clip through `melspectrogram.onnx` → `embedding_model.onnx`
     to get `[16, 96]` embedding windows the head consumes. Cached to `--cache`.
  4. Train — `train_head()`: 2–3 dense layers + BCE, the notebook's default
     schedule. Validate on held-out positives + a hard-negative set; tune the
     operating `threshold`.
  5. Export — `export_head_onnx()`: ONNX with input `[1, 16, 96]` float32 →
     scalar P(wake), the exact shape `wake-word.ts` feeds it.
  6. Provenance — `write_provenance()`: phrase, openWakeWord commit, TTS source
     + license, dataset sizes, threshold, held-out true-accept / false-accept.

Full real run (on the training box — needs network for the front-end graphs and
a real negative corpus, plus a TTS for ~30k positives):

  uv run --extra train python -m scripts.wakeword.train_eliza1_wakeword_head \\
      --phrase "hey eliza" \\
      --positives-dir /data/wakeword/hey-eliza-positives \\
      --negatives-dir /data/wakeword/negatives \\
      --out wake/hey-eliza.onnx \\
      --provenance wake/hey-eliza.provenance.json \\
      --epochs 30

Then: stage `wake/{melspectrogram,embedding_model,hey-eliza}.onnx` into the tier
bundles, point `WAKEWORD_FILES`/`OPENWAKEWORD_DEFAULT_HEAD` at it, and **remove
`hey-eliza` from `OPENWAKEWORD_PLACEHOLDER_HEADS`** (it is now a real head for
the real phrase).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# openWakeWord front-end constants — fixed by the upstream graphs. The head
# windows over 16 embeddings; each embedding is 96-dim; the embedding model
# windows over 76 mel frames and hops 8; the melspectrogram emits 32 bins per
# frame at 16 kHz. These mirror `voice/wake-word.ts`.
SAMPLE_RATE = 16_000
MEL_BINS = 32
EMBEDDING_DIM = 96
EMBEDDING_WINDOW_FRAMES = 76
HEAD_WINDOW_EMBEDDINGS = 16

# openWakeWord release that hosts the model-agnostic front-end graphs.
OPENWAKEWORD_RELEASE = (
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
)
FRONT_END_GRAPHS = ("melspectrogram.onnx", "embedding_model.onnx")

DEFAULT_PHRASE = "hey eliza"


# ---------------------------------------------------------------------------
# 1. Positives — TTS synthesis wrappers (optional; staging the dir works too)
# ---------------------------------------------------------------------------


def _have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def synthesize_positives_espeak(
    phrase: str, out_dir: Path, *, count: int, seed: int = 0
) -> int:
    """Synthesize `count` "phrase" clips with espeak-ng, varying voice/speed/pitch.

    Returns the number of clips written. A poor-man's augmentation — espeak's
    formant synth is robotic, so this is a *bootstrap* set, not a substitute for
    the piper-based ~30k-clip pipeline the notebook uses. Requires `espeak-ng`
    and `ffmpeg` on PATH.
    """
    if not _have("espeak-ng") or not _have("ffmpeg"):
        raise RuntimeError(
            "synthesize_positives_espeak needs `espeak-ng` and `ffmpeg` on PATH"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    voices = ["en-us", "en-gb", "en-gb-x-rp", "en-us-nyc", "en"]
    written = 0
    rnd = _Lcg(seed or 1)
    for i in range(count):
        voice = voices[i % len(voices)]
        speed = 120 + int(rnd.next() % 80)  # 120..199 wpm
        pitch = 30 + int(rnd.next() % 50)  # 30..79
        raw = out_dir / f"pos-{i:05d}.raw.wav"
        wav = out_dir / f"pos-{i:05d}.wav"
        subprocess.run(  # noqa: S603,S607
            ["espeak-ng", "-v", voice, "-s", str(speed), "-p", str(pitch), "-w", str(raw), phrase],
            check=True,
            capture_output=True,
        )
        subprocess.run(  # noqa: S603,S607
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-ar", str(SAMPLE_RATE), "-ac", "1", str(wav)],
            check=True,
            capture_output=True,
        )
        raw.unlink(missing_ok=True)
        written += 1
    return written


class _Lcg:
    """Tiny deterministic PRNG so synthesis is reproducible without numpy."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF or 1

    def next(self) -> int:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state


# ---------------------------------------------------------------------------
# 2/3. Read WAVs → openWakeWord embedding windows
# ---------------------------------------------------------------------------


def read_wav_pcm16_mono(path: Path) -> list[float]:
    """Read a 16 kHz mono PCM16 WAV into a list of floats in [-1, 1]."""
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(
                f"{path}: expected 16 kHz mono PCM16, got "
                f"{w.getframerate()} Hz / {w.getnchannels()} ch / {w.getsampwidth()*8}-bit"
            )
        raw = w.readframes(w.getnframes())
    import array

    pcm = array.array("h")
    pcm.frombytes(raw)
    return [s / 32768.0 for s in pcm]


def embedding_windows_for_wav(path: Path, front_end: "OpenWakeWordFrontEnd") -> list[list[list[float]]]:
    """Run a WAV through the front-end → a list of `[16, 96]` embedding windows.

    A clip shorter than the head window yields zero windows (skipped). A longer
    clip yields one window per hop — the head trains on each.
    """
    pcm = read_wav_pcm16_mono(path)
    return front_end.embedding_windows(pcm)


class OpenWakeWordFrontEnd:
    """Frozen melspectrogram → embedding ONNX front-end (the model-agnostic part).

    Loads `melspectrogram.onnx` + `embedding_model.onnx` (download them once
    from the openWakeWord GitHub release into `--front-end-dir`). `onnxruntime`
    is required only when this is actually used — the rest of the script
    (head architecture, ONNX export shape) is importable without it.
    """

    def __init__(self, mel_path: Path, emb_path: Path) -> None:
        import onnxruntime as ort  # noqa: PLC0415 - optional dep, only here

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.mel = ort.InferenceSession(str(mel_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.emb = ort.InferenceSession(str(emb_path), sess_options=opts, providers=["CPUExecutionProvider"])

    def embedding_windows(self, pcm: list[float]) -> list[list[list[float]]]:
        import numpy as np  # noqa: PLC0415

        audio = np.asarray(pcm, dtype=np.float32)[None, :]
        mel = self.mel.run(None, {self.mel.get_inputs()[0].name: audio})[0]
        # openWakeWord rescales the melspectrogram before the embedding model.
        mel = (mel.squeeze() / 10.0) + 2.0  # shape [n_frames, 32]
        n_frames = mel.shape[0]
        embeds: list[np.ndarray] = []
        # Slide a 76-frame window with hop 8 (the runtime's EMBEDDING_HOP).
        for start in range(0, max(0, n_frames - EMBEDDING_WINDOW_FRAMES) + 1, 8):
            win = mel[start : start + EMBEDDING_WINDOW_FRAMES][None, :, :, None]
            e = self.emb.run(None, {self.emb.get_inputs()[0].name: win.astype(np.float32)})[0]
            embeds.append(e.reshape(-1))  # [96]
        # Now slide a 16-embedding window over the embedding stream.
        windows: list[list[list[float]]] = []
        for start in range(0, max(0, len(embeds) - HEAD_WINDOW_EMBEDDINGS) + 1):
            chunk = embeds[start : start + HEAD_WINDOW_EMBEDDINGS]
            windows.append([list(map(float, v)) for v in chunk])
        return windows


# ---------------------------------------------------------------------------
# 4. The dense head — a small torch model, trained with BCE
# ---------------------------------------------------------------------------


def build_head_module(hidden: int = 96):
    """The wake-word head: flatten `[16, 96]` → 2 dense layers → sigmoid scalar.

    Matches the openWakeWord head shape (a small MLP on the flattened embedding
    window). `torch` is required only when this is called.
    """
    import torch  # noqa: PLC0415
    import torch.nn as nn  # noqa: PLC0415

    class Head(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.net = nn.Sequential(
                nn.Flatten(start_dim=1),
                nn.Linear(HEAD_WINDOW_EMBEDDINGS * EMBEDDING_DIM, hidden),
                nn.LayerNorm(hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
                nn.Linear(hidden, 1),
            )

        def forward(self, x):  # x: [B, 16, 96]
            return torch.sigmoid(self.net(x)).squeeze(-1)

    return Head()


def train_head(
    pos_windows: list[list[list[float]]],
    neg_windows: list[list[list[float]]],
    *,
    epochs: int = 30,
    lr: float = 1e-3,
    batch_size: int = 256,
    val_frac: float = 0.15,
    seed: int = 0,
):
    """Train the dense head; return `(module, metrics)`.

    `metrics` carries the held-out true-accept rate at the chosen threshold and
    the false-accept rate over the held-out negatives — record these in the
    provenance JSON. `torch` is required.
    """
    import torch  # noqa: PLC0415

    torch.manual_seed(seed)
    x_pos = torch.tensor(pos_windows, dtype=torch.float32)
    x_neg = torch.tensor(neg_windows, dtype=torch.float32)
    if x_pos.numel() == 0 or x_neg.numel() == 0:
        raise RuntimeError("need both positive and negative embedding windows to train")
    # Train/val split (per class).
    def split(t):
        n_val = max(1, int(round(t.shape[0] * val_frac)))
        perm = torch.randperm(t.shape[0])
        return t[perm[n_val:]], t[perm[:n_val]]

    pos_tr, pos_val = split(x_pos)
    neg_tr, neg_val = split(x_neg)
    x_tr = torch.cat([pos_tr, neg_tr], dim=0)
    y_tr = torch.cat([torch.ones(pos_tr.shape[0]), torch.zeros(neg_tr.shape[0])])
    model = build_head_module()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = torch.nn.BCELoss()
    n = x_tr.shape[0]
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(n)
        ep_loss = 0.0
        for i in range(0, n, batch_size):
            idx = perm[i : i + batch_size]
            opt.zero_grad()
            out = model(x_tr[idx])
            loss = loss_fn(out, y_tr[idx])
            loss.backward()
            opt.step()
            ep_loss += loss.item() * idx.shape[0]
        if (ep + 1) % max(1, epochs // 5) == 0:
            print(f"[wakeword-train] epoch {ep+1}/{epochs} loss={ep_loss/n:.4f}")
    # Pick a threshold: the smallest that keeps held-out false-accept <= 0.5%.
    model.eval()
    with torch.no_grad():
        pos_scores = model(pos_val).tolist() if pos_val.shape[0] else []
        neg_scores = model(neg_val).tolist() if neg_val.shape[0] else []
    threshold = _pick_threshold(pos_scores, neg_scores)
    true_accept = sum(1 for s in pos_scores if s >= threshold) / max(1, len(pos_scores))
    false_accept = sum(1 for s in neg_scores if s >= threshold) / max(1, len(neg_scores))
    metrics = {
        "threshold": round(threshold, 4),
        "heldOutPositives": len(pos_scores),
        "heldOutNegatives": len(neg_scores),
        "trueAcceptRate": round(true_accept, 4),
        "falseAcceptRate": round(false_accept, 4),
        "epochs": epochs,
    }
    return model, metrics


def _pick_threshold(pos_scores: Iterable[float], neg_scores: Iterable[float]) -> float:
    """Smallest threshold in [0.1, 0.95] with held-out false-accept <= 0.5%."""
    neg = sorted(neg_scores)
    n = len(neg)
    for t in [i / 100 for i in range(10, 96)]:
        fa = sum(1 for s in neg if s >= t) / max(1, n)
        if fa <= 0.005:
            return t
    return 0.5


# ---------------------------------------------------------------------------
# 5. Export ONNX with the runtime's input shape
# ---------------------------------------------------------------------------


def export_head_onnx(model, out_path: Path) -> None:
    """Export the head to ONNX: input `[1, 16, 96]` float32 → scalar P(wake).

    This is exactly the shape `OpenWakeWordModel.scoreFrame` feeds it
    (`voice/wake-word.ts`). Uses the legacy TorchScript exporter (`dynamo=False`)
    so it only needs `torch` + `onnx`, not `onnxscript`. `torch` is required.
    """
    import torch  # noqa: PLC0415

    out_path.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, HEAD_WINDOW_EMBEDDINGS, EMBEDDING_DIM, dtype=torch.float32)
    model.eval()
    kwargs = dict(
        input_names=["embedding_window"],
        output_names=["wake_prob"],
        dynamic_axes={"embedding_window": {0: "batch"}, "wake_prob": {0: "batch"}},
        opset_version=17,
    )
    # torch >= 2.5 defaults to the dynamo exporter (needs `onnxscript`); the
    # legacy TorchScript exporter only needs `torch` + `onnx`. Prefer it.
    try:
        torch.onnx.export(model, dummy, str(out_path), dynamo=False, **kwargs)
    except TypeError:
        # Older torch without the `dynamo` kwarg — already uses TorchScript.
        torch.onnx.export(model, dummy, str(out_path), **kwargs)


# ---------------------------------------------------------------------------
# 6. Provenance
# ---------------------------------------------------------------------------


def write_provenance(
    path: Path,
    *,
    phrase: str,
    head_onnx: Path,
    metrics: dict,
    tts_source: str,
    n_positives: int,
    n_negatives: int,
    openwakeword_release: str = OPENWAKEWORD_RELEASE,
) -> None:
    blob = {
        "wakePhrase": phrase,
        "headOnnx": str(head_onnx),
        "headSha256": _sha256(head_onnx) if head_onnx.is_file() else None,
        "openWakeWordRelease": openwakeword_release,
        "frontEndGraphs": list(FRONT_END_GRAPHS),
        "ttsSource": tts_source,
        "license": {
            "openWakeWord": "Apache-2.0",
            "frontEndGraphs": "Apache-2.0",
            "trainedHead": "inherits the TTS license used for positives — use a permissive TTS (piper voices are MIT/CC0-ish) so the head stays redistributable",
        },
        "dataset": {"positives": n_positives, "negatives": n_negatives},
        "headMetrics": metrics,
        "trainedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runtimeContract": {
            "inputShape": [1, HEAD_WINDOW_EMBEDDINGS, EMBEDDING_DIM],
            "output": "scalar P(wake) in [0, 1]",
            "frontEnd": "melspectrogram.onnx -> embedding_model.onnx (x/10 + 2 rescale before the embedding model)",
            "consumer": "packages/app-core/src/services/local-inference/voice/wake-word.ts",
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(blob, indent=2) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Front-end download (one-time)
# ---------------------------------------------------------------------------


def ensure_front_end_graphs(dest: Path) -> tuple[Path, Path]:
    """Ensure `melspectrogram.onnx` + `embedding_model.onnx` are in `dest`.

    Downloads them from the openWakeWord GitHub release if missing. Needs
    network + `curl` (or pass an already-populated `--front-end-dir`).
    """
    dest.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    for name in FRONT_END_GRAPHS:
        p = dest / name
        if not p.is_file() or p.stat().st_size < 1000:
            url = f"{OPENWAKEWORD_RELEASE}/{name}"
            if not _have("curl"):
                raise RuntimeError(f"need {p} (download from {url}) — `curl` not on PATH")
            subprocess.run(["curl", "-fsSL", "-o", str(p), url], check=True)  # noqa: S603,S607
        out.append(p)
    return out[0], out[1]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _windows_for_dir(d: Path, front_end: OpenWakeWordFrontEnd) -> list[list[list[float]]]:
    out: list[list[list[float]]] = []
    wavs = sorted(d.glob("*.wav"))
    if not wavs:
        raise RuntimeError(f"no *.wav files in {d}")
    for i, w in enumerate(wavs):
        out.extend(embedding_windows_for_wav(w, front_end))
        if (i + 1) % 500 == 0:
            print(f"[wakeword-train] featurized {i+1}/{len(wavs)} clips from {d.name} -> {len(out)} windows")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phrase", default=DEFAULT_PHRASE, help='Wake phrase. Default "hey eliza".')
    ap.add_argument("--positives-dir", type=Path, required=True, help="Dir of *.wav (16 kHz mono) of the phrase.")
    ap.add_argument("--negatives-dir", type=Path, required=True, help="Dir of *.wav (16 kHz mono) NOT containing the phrase.")
    ap.add_argument("--front-end-dir", type=Path, default=Path("./.wakeword-front-end"), help="Where melspectrogram.onnx + embedding_model.onnx live (downloaded if missing).")
    ap.add_argument("--cache", type=Path, default=None, help="Optional .json cache of computed embedding windows (skips re-featurization).")
    ap.add_argument("--out", type=Path, required=True, help="Output head ONNX path (e.g. wake/hey-eliza.onnx).")
    ap.add_argument("--provenance", type=Path, default=None, help="Output provenance JSON (defaults to <out>.provenance.json).")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tts-source", default="caller-staged WAVs (record the real source here)", help="TTS provenance note (e.g. 'piper en_US-* voices, MIT/CC0').")
    args = ap.parse_args(argv)

    front_mel, front_emb = ensure_front_end_graphs(args.front_end_dir)
    front_end = OpenWakeWordFrontEnd(front_mel, front_emb)

    cache: dict[str, list] = {}
    if args.cache and args.cache.is_file():
        cache = json.loads(args.cache.read_text())
    if "pos" in cache and "neg" in cache:
        pos_w, neg_w = cache["pos"], cache["neg"]
        print(f"[wakeword-train] loaded {len(pos_w)} pos / {len(neg_w)} neg windows from cache")
    else:
        pos_w = _windows_for_dir(args.positives_dir, front_end)
        neg_w = _windows_for_dir(args.negatives_dir, front_end)
        if args.cache:
            args.cache.write_text(json.dumps({"pos": pos_w, "neg": neg_w}))
    print(f"[wakeword-train] {len(pos_w)} positive windows / {len(neg_w)} negative windows")

    model, metrics = train_head(pos_w, neg_w, epochs=args.epochs, seed=args.seed)
    print(f"[wakeword-train] metrics: {metrics}")
    export_head_onnx(model, args.out)
    print(f"[wakeword-train] wrote head ONNX -> {args.out}")
    prov = args.provenance or args.out.with_suffix(".provenance.json")
    write_provenance(
        prov,
        phrase=args.phrase,
        head_onnx=args.out,
        metrics=metrics,
        tts_source=args.tts_source,
        n_positives=len(list(args.positives_dir.glob("*.wav"))),
        n_negatives=len(list(args.negatives_dir.glob("*.wav"))),
    )
    print(f"[wakeword-train] wrote provenance -> {prov}")
    print(
        "[wakeword-train] DONE. Next: stage wake/{melspectrogram,embedding_model,"
        f"{args.out.stem}}}.onnx into the tier bundles, point WAKEWORD_FILES / "
        "OPENWAKEWORD_DEFAULT_HEAD at it, and remove the head from "
        "OPENWAKEWORD_PLACEHOLDER_HEADS in voice/wake-word.ts."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
