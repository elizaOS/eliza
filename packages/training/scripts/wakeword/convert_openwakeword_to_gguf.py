#!/usr/bin/env python3
"""Convert the upstream openWakeWord ONNX trio into one combined GGUF.

The TS runtime (`plugins/plugin-local-inference/src/services/voice/wake-word.ts`)
used to load three ONNX graphs through `onnxruntime-node`:

    1. `wake/melspectrogram.onnx`   — fixed Mel filterbank.
    2. `wake/embedding_model.onnx`  — Google speech-embedding TFLite (~10 MB).
    3. `wake/<phrase>.onnx`         — per-phrase MLP classifier head (~100 KB).

The GGUF/llama.cpp port replaces all three with a single combined GGUF the
fused `libelizainference` build mmaps at `wake/openwakeword.gguf`. The C
runtime owns the mel filterbank constants, the embedding model weights,
and every per-phrase classifier head — `eliza_inference_wakeword_open`
selects which head to bind by name (e.g. `"hey-eliza"`).

This script is the upstream→GGUF migration tool:

  uv run python -m scripts.wakeword.convert_openwakeword_to_gguf \
      --melspectrogram /path/to/melspectrogram.onnx \
      --embedding-model /path/to/embedding_model.onnx \
      --head hey-eliza:/path/to/hey-eliza.onnx \
      [--head hey-jarvis:/path/to/hey_jarvis_v0.1.onnx ...] \
      --out wake/openwakeword.gguf

It loads each ONNX, walks its `graph.initializer` (every weight tensor),
and writes a GGUF with namespaced tensor names:

    mel.<onnx-tensor-name>           # filterbank constants + biases
    embed.<onnx-tensor-name>         # speech embedding model weights
    head.<name>.<onnx-tensor-name>   # one prefix per --head, e.g.
                                     # head.hey-eliza.dense.weight ...

Plus a small KV block of architectural metadata the C runtime checks at
mmap_acquire time:

    openwakeword.format_version           u32      = 1
    openwakeword.sample_rate              u32      = 16000
    openwakeword.frame_samples            u32      = 1280
    openwakeword.mel_bins                 u32      = 32
    openwakeword.embedding_window_frames  u32      = 76
    openwakeword.embedding_hop_frames     u32      = 8
    openwakeword.embedding_dim            u32      = 96
    openwakeword.head_window_embeddings   u32      = 16
    openwakeword.head_names               [str]    = ["hey-eliza", ...]
    openwakeword.provenance.openwakeword_release = "v0.5.1"
    openwakeword.provenance.notes         str
    openwakeword.head.<name>.placeholder  bool     # true when the file
                                                   # is the upstream
                                                   # hey_jarvis_v0.1
                                                   # renamed (no real
                                                   # phrase training).

The format intentionally mirrors what the runtime needs to consume; the
actual numeric layout (CONV2D weight order, channels-first vs channels-
last) follows the ONNX storage 1:1 — the C++ loader does any per-op
reshape on the fly, the same way the ONNX runtime does. Keeping the
weights verbatim means re-converting after a head retrain is trivial.

Notes on dependencies:

  - `onnx` and `numpy` are the only required Python deps. There is no
    ONNX *runtime* dependency — we only read the static graph + weights.
  - The GGUF writer is `gguf` (the upstream llama.cpp package); fall
    back to a tiny hand-rolled writer when `gguf` is not installed
    so a fresh checkout can run the script without a heavy uv extra.

This is the only blessed path from upstream openWakeWord weights to the
bundled `openwakeword.gguf`. Run it as part of staging an Eliza-1 voice
bundle; the resulting GGUF then lives at `wake/openwakeword.gguf`
alongside `wake/openwakeword.provenance.json` (the JSON produced by
`train_eliza1_wakeword_head.py` for any newly-trained heads).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# Architectural constants — mirror `voice/wake-word.ts` and the upstream
# openWakeWord (v0.5.1) front-end graphs. If the upstream graph changes,
# update both this script AND the C runtime in lockstep.
FORMAT_VERSION = 1
SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1280
MEL_BINS = 32
EMBEDDING_WINDOW_FRAMES = 76
EMBEDDING_HOP_FRAMES = 8
EMBEDDING_DIM = 96
HEAD_WINDOW_EMBEDDINGS = 16

# Heads that are placeholders (the upstream `hey_jarvis_v0.1.onnx`
# renamed). Mirrors `OPENWAKEWORD_PLACEHOLDER_HEADS` in wake-word.ts.
PLACEHOLDER_HEAD_SHA_FILENAMES = {"hey_jarvis_v0.1.onnx"}


@dataclass
class HeadSpec:
    """One `--head name:path` entry."""

    name: str
    onnx_path: Path
    source_filename: str  # for the placeholder check
    is_placeholder: bool = False


@dataclass
class Tensor:
    """One named weight tensor extracted from an ONNX graph."""

    name: str  # final GGUF tensor name (namespaced)
    shape: tuple[int, ...]
    dtype: str  # "f32" | "f16" | "i32" | "i64" | "u8" — same set as ggml core
    data: bytes  # raw little-endian buffer


@dataclass
class MetadataKV:
    """One GGUF KV pair the runtime reads at mmap_acquire time."""

    key: str
    type: str  # "u32" | "str" | "bool" | "str_array"
    value: object


@dataclass
class Bundle:
    """The full set of tensors + metadata destined for the combined GGUF."""

    tensors: list[Tensor] = field(default_factory=list)
    metadata: list[MetadataKV] = field(default_factory=list)


# --------------------------------------------------------------------------
# ONNX → tensor extraction
# --------------------------------------------------------------------------


def _load_onnx(path: Path):
    """Import onnx lazily so the script imports without the optional dep."""
    try:
        import onnx  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise SystemExit(
            "[convert-openwakeword-to-gguf] `onnx` is required to read the upstream graphs. "
            "Install it: `uv pip install onnx numpy` (or `pip install onnx numpy`)."
        ) from exc
    return onnx.load(str(path))


def _initializer_tensors(model, *, prefix: str) -> Iterable[Tensor]:
    """Walk `graph.initializer` and yield every weight tensor.

    `prefix` is prepended to every tensor name so the combined GGUF can host
    all three sub-models without collisions (`mel.*`, `embed.*`, `head.<n>.*`).
    """
    import numpy as np  # type: ignore[import-not-found]
    from onnx import numpy_helper  # type: ignore[import-not-found]

    for init in model.graph.initializer:
        arr: "np.ndarray" = numpy_helper.to_array(init)
        dtype = _np_dtype_to_ggml(arr.dtype)
        # Force contiguous, little-endian; GGUF readers expect raw LE buffers.
        if not arr.flags["C_CONTIGUOUS"]:
            arr = np.ascontiguousarray(arr)
        if arr.dtype.byteorder == ">":
            arr = arr.byteswap().newbyteorder("<")
        yield Tensor(
            name=f"{prefix}.{init.name}",
            shape=tuple(int(d) for d in arr.shape),
            dtype=dtype,
            data=arr.tobytes(),
        )


def _np_dtype_to_ggml(dtype) -> str:
    """Map a numpy dtype string to the small ggml-compatible label set."""
    import numpy as np  # type: ignore[import-not-found]

    if dtype == np.float32:
        return "f32"
    if dtype == np.float16:
        return "f16"
    if dtype == np.int32:
        return "i32"
    if dtype == np.int64:
        return "i64"
    if dtype == np.uint8:
        return "u8"
    raise ValueError(
        f"[convert-openwakeword-to-gguf] unsupported tensor dtype {dtype}. "
        "Add a mapping if the upstream graphs start using it."
    )


# --------------------------------------------------------------------------
# Head spec parsing
# --------------------------------------------------------------------------


def _parse_head_arg(spec: str) -> HeadSpec:
    """Parse `--head <name>:<path>` (or `<name>=<path>`)."""
    if ":" in spec:
        name, raw = spec.split(":", 1)
    elif "=" in spec:
        name, raw = spec.split("=", 1)
    else:
        raise SystemExit(
            f"[convert-openwakeword-to-gguf] --head expects 'name:/path/to.onnx', got {spec!r}"
        )
    name = name.strip()
    if not name:
        raise SystemExit(
            f"[convert-openwakeword-to-gguf] --head missing name in {spec!r}"
        )
    p = Path(raw.strip()).expanduser()
    if not p.is_file():
        raise SystemExit(
            f"[convert-openwakeword-to-gguf] head ONNX not found: {p}"
        )
    src = p.name
    return HeadSpec(
        name=name,
        onnx_path=p,
        source_filename=src,
        is_placeholder=src in PLACEHOLDER_HEAD_SHA_FILENAMES,
    )


# --------------------------------------------------------------------------
# Bundle assembly
# --------------------------------------------------------------------------


def build_bundle(
    *,
    melspectrogram: Path,
    embedding_model: Path,
    heads: list[HeadSpec],
    provenance_notes: str,
    openwakeword_release: str,
) -> Bundle:
    """Read the three ONNX inputs and assemble the combined Bundle."""
    bundle = Bundle()

    # 1. Melspectrogram filterbank.
    mel_model = _load_onnx(melspectrogram)
    for t in _initializer_tensors(mel_model, prefix="mel"):
        bundle.tensors.append(t)

    # 2. Speech embedding model.
    emb_model = _load_onnx(embedding_model)
    for t in _initializer_tensors(emb_model, prefix="embed"):
        bundle.tensors.append(t)

    # 3. Heads — one prefix per head.
    head_names: list[str] = []
    for head in heads:
        head_names.append(head.name)
        head_model = _load_onnx(head.onnx_path)
        for t in _initializer_tensors(head_model, prefix=f"head.{head.name}"):
            bundle.tensors.append(t)
        bundle.metadata.append(
            MetadataKV(
                key=f"openwakeword.head.{head.name}.placeholder",
                type="bool",
                value=head.is_placeholder,
            )
        )
        bundle.metadata.append(
            MetadataKV(
                key=f"openwakeword.head.{head.name}.source_filename",
                type="str",
                value=head.source_filename,
            )
        )

    # Architectural metadata — the runtime hard-checks these against its
    # compiled-in constants (`FRAME_SAMPLES`, `MEL_BINS`, ...).
    for k, v in (
        ("openwakeword.format_version", FORMAT_VERSION),
        ("openwakeword.sample_rate", SAMPLE_RATE),
        ("openwakeword.frame_samples", FRAME_SAMPLES),
        ("openwakeword.mel_bins", MEL_BINS),
        ("openwakeword.embedding_window_frames", EMBEDDING_WINDOW_FRAMES),
        ("openwakeword.embedding_hop_frames", EMBEDDING_HOP_FRAMES),
        ("openwakeword.embedding_dim", EMBEDDING_DIM),
        ("openwakeword.head_window_embeddings", HEAD_WINDOW_EMBEDDINGS),
    ):
        bundle.metadata.append(MetadataKV(key=k, type="u32", value=int(v)))

    bundle.metadata.extend(
        [
            MetadataKV(
                key="openwakeword.head_names",
                type="str_array",
                value=head_names,
            ),
            MetadataKV(
                key="openwakeword.provenance.openwakeword_release",
                type="str",
                value=openwakeword_release,
            ),
            MetadataKV(
                key="openwakeword.provenance.notes",
                type="str",
                value=provenance_notes,
            ),
        ]
    )

    return bundle


# --------------------------------------------------------------------------
# GGUF writer
# --------------------------------------------------------------------------


def _write_with_official_gguf(bundle: Bundle, out_path: Path) -> bool:
    """Write via the upstream `gguf` package when available. Returns True on success."""
    try:
        import gguf  # type: ignore[import-not-found]
    except ImportError:
        return False
    import numpy as np  # type: ignore[import-not-found]

    writer = gguf.GGUFWriter(str(out_path), "openwakeword")
    # KV pairs.
    for kv in bundle.metadata:
        if kv.type == "u32":
            writer.add_uint32(kv.key, int(kv.value))  # type: ignore[arg-type]
        elif kv.type == "bool":
            writer.add_bool(kv.key, bool(kv.value))  # type: ignore[arg-type]
        elif kv.type == "str":
            writer.add_string(kv.key, str(kv.value))
        elif kv.type == "str_array":
            writer.add_array(kv.key, list(kv.value))  # type: ignore[arg-type]
        else:
            raise SystemExit(
                f"[convert-openwakeword-to-gguf] unhandled metadata type {kv.type!r}"
            )
    # Tensors.
    for t in bundle.tensors:
        dtype_map = {
            "f32": np.float32,
            "f16": np.float16,
            "i32": np.int32,
            "i64": np.int64,
            "u8": np.uint8,
        }
        arr = np.frombuffer(t.data, dtype=dtype_map[t.dtype])
        if t.shape:
            arr = arr.reshape(t.shape)
        writer.add_tensor(t.name, arr)
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    return True


# Minimal fall-back writer — only the subset of the GGUF v3 format the
# native loader needs. It writes everything the official writer would,
# in the same on-disk shape. Kept around so a fresh checkout without
# `gguf` can still produce the file (we don't want to gate the entire
# pipeline on an optional dep). The official writer is preferred.
GGUF_MAGIC = b"GGUF"
GGUF_VERSION = 3


_GGUF_TYPE_UINT32 = 4
_GGUF_TYPE_BOOL = 7
_GGUF_TYPE_STRING = 8
_GGUF_TYPE_ARRAY = 9

# Sentinel values mirror the ggml enum (`ggml_type`).
_GGML_TYPE_F32 = 0
_GGML_TYPE_F16 = 1
_GGML_TYPE_I8 = 16
_GGML_TYPE_I16 = 17
_GGML_TYPE_I32 = 18
_GGML_TYPE_I64 = 27
_GGML_TYPE_F64 = 28


def _ggml_type_for(dtype: str) -> int:
    return {
        "f32": _GGML_TYPE_F32,
        "f16": _GGML_TYPE_F16,
        "i32": _GGML_TYPE_I32,
        "i64": _GGML_TYPE_I64,
        "u8": _GGML_TYPE_I8,  # close enough — u8 storage; the runtime
        # only uses fp32/fp16 weights, this is the
        # safe fallback for the rare 1-byte tensor.
    }[dtype]


def _pack_string(s: str) -> bytes:
    raw = s.encode("utf-8")
    return struct.pack("<Q", len(raw)) + raw


def _pack_kv(kv: MetadataKV) -> bytes:
    key = _pack_string(kv.key)
    if kv.type == "u32":
        return key + struct.pack("<I", _GGUF_TYPE_UINT32) + struct.pack(
            "<I", int(kv.value)
        )  # type: ignore[arg-type]
    if kv.type == "bool":
        return (
            key
            + struct.pack("<I", _GGUF_TYPE_BOOL)
            + struct.pack("<B", 1 if kv.value else 0)
        )
    if kv.type == "str":
        return key + struct.pack("<I", _GGUF_TYPE_STRING) + _pack_string(str(kv.value))
    if kv.type == "str_array":
        items = list(kv.value)  # type: ignore[arg-type]
        body = struct.pack("<I", _GGUF_TYPE_STRING) + struct.pack("<Q", len(items))
        for s in items:
            body += _pack_string(str(s))
        return key + struct.pack("<I", _GGUF_TYPE_ARRAY) + body
    raise SystemExit(f"[convert-openwakeword-to-gguf] unhandled kv type {kv.type!r}")


def _write_with_fallback_writer(bundle: Bundle, out_path: Path) -> None:
    """Hand-rolled GGUF writer for environments without the `gguf` package."""
    # Header.
    header = bytearray()
    header += GGUF_MAGIC
    header += struct.pack("<I", GGUF_VERSION)
    header += struct.pack("<Q", len(bundle.tensors))
    header += struct.pack("<Q", len(bundle.metadata))

    # KV section.
    kv_blob = bytearray()
    for kv in bundle.metadata:
        kv_blob += _pack_kv(kv)

    # Tensor metadata section.
    tensor_meta = bytearray()
    offsets: list[int] = []
    running = 0
    alignment = 32
    for t in bundle.tensors:
        tensor_meta += _pack_string(t.name)
        tensor_meta += struct.pack("<I", max(1, len(t.shape)))
        # Pad shape to at least 1 dim (ggml convention: trailing 1s implied).
        dims = list(t.shape) if t.shape else [1]
        for d in dims:
            tensor_meta += struct.pack("<Q", int(d))
        tensor_meta += struct.pack("<I", _ggml_type_for(t.dtype))
        offsets.append(running)
        tensor_meta += struct.pack("<Q", running)
        # Advance running offset with alignment.
        size = len(t.data)
        pad = (-size) % alignment
        running += size + pad

    # Now we know the size of (header + kv + tensor_meta); align the data
    # section to `alignment`.
    pre = bytes(header) + bytes(kv_blob) + bytes(tensor_meta)
    pad_to_data = (-len(pre)) % alignment
    pre += b"\0" * pad_to_data

    with out_path.open("wb") as f:
        f.write(pre)
        for t in bundle.tensors:
            f.write(t.data)
            pad = (-len(t.data)) % alignment
            if pad:
                f.write(b"\0" * pad)


def write_gguf(bundle: Bundle, out_path: Path) -> str:
    """Write the bundle to `out_path` and return the writer used ('gguf' or 'fallback')."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if _write_with_official_gguf(bundle, out_path):
        return "gguf"
    _write_with_fallback_writer(bundle, out_path)
    return "fallback"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--melspectrogram",
        type=Path,
        required=True,
        help="Path to upstream melspectrogram.onnx.",
    )
    ap.add_argument(
        "--embedding-model",
        type=Path,
        required=True,
        help="Path to upstream embedding_model.onnx.",
    )
    ap.add_argument(
        "--head",
        dest="heads",
        action="append",
        required=True,
        help="`name:/path/to.onnx`. May be repeated to bundle multiple heads.",
    )
    ap.add_argument(
        "--openwakeword-release",
        default="v0.5.1",
        help="Upstream openWakeWord release these graphs come from (for provenance KV).",
    )
    ap.add_argument(
        "--provenance-notes",
        default="",
        help="Free-form provenance string (e.g. trained-head metrics, TTS license).",
    )
    ap.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output GGUF path (e.g. wake/openwakeword.gguf).",
    )
    ap.add_argument(
        "--provenance",
        type=Path,
        default=None,
        help="Optional sidecar provenance JSON path. Defaults to <out>.provenance.json.",
    )
    args = ap.parse_args(argv)

    if not args.melspectrogram.is_file():
        raise SystemExit(f"melspectrogram not found: {args.melspectrogram}")
    if not args.embedding_model.is_file():
        raise SystemExit(f"embedding_model not found: {args.embedding_model}")
    heads = [_parse_head_arg(h) for h in args.heads]
    if not heads:
        raise SystemExit("at least one --head is required")

    bundle = build_bundle(
        melspectrogram=args.melspectrogram,
        embedding_model=args.embedding_model,
        heads=heads,
        provenance_notes=args.provenance_notes,
        openwakeword_release=args.openwakeword_release,
    )
    writer = write_gguf(bundle, args.out)
    print(
        f"[convert-openwakeword-to-gguf] wrote {args.out} "
        f"({len(bundle.tensors)} tensors, {len(bundle.metadata)} KV pairs, writer={writer})",
        file=sys.stderr,
    )

    # Provenance sidecar.
    prov_path = args.provenance or args.out.with_suffix(args.out.suffix + ".provenance.json")
    prov = {
        "format": "openwakeword.gguf",
        "formatVersion": FORMAT_VERSION,
        "openWakeWordRelease": args.openwakeword_release,
        "notes": args.provenance_notes,
        "sources": {
            "melspectrogram": str(args.melspectrogram),
            "embedding_model": str(args.embedding_model),
            "heads": [
                {
                    "name": h.name,
                    "path": str(h.onnx_path),
                    "sourceFilename": h.source_filename,
                    "placeholder": h.is_placeholder,
                }
                for h in heads
            ],
        },
        "runtimeContract": {
            "sampleRate": SAMPLE_RATE,
            "frameSamples": FRAME_SAMPLES,
            "melBins": MEL_BINS,
            "embeddingWindowFrames": EMBEDDING_WINDOW_FRAMES,
            "embeddingHopFrames": EMBEDDING_HOP_FRAMES,
            "embeddingDim": EMBEDDING_DIM,
            "headWindowEmbeddings": HEAD_WINDOW_EMBEDDINGS,
            "consumer": "plugins/plugin-local-inference/src/services/voice/wake-word.ts",
            "ffi": "eliza_inference_wakeword_* (ABI v5)",
        },
    }
    prov_path.parent.mkdir(parents=True, exist_ok=True)
    prov_path.write_text(json.dumps(prov, indent=2) + "\n", encoding="utf-8")
    print(f"[convert-openwakeword-to-gguf] wrote provenance -> {prov_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
