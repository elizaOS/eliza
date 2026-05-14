#!/usr/bin/env python3
# Persistent OpenVINO Whisper worker. Spoken to by openvino-whisper-asr.ts
# over stdin/stdout with a tiny length-prefixed binary protocol:
#
#   request  = u32 LE n_samples + n_samples * float32 LE
#   response = u32 LE n_bytes   + n_bytes UTF-8 text
#
# Designed to stay alive across many decode windows so we pay the
# WhisperPipeline.compile() cost (~3 s on NPU, ~0.5 s on CPU) exactly once
# per process. Device chain defaults to NPU,CPU but is configurable via
# the ELIZA_OPENVINO_WHISPER_DEVICE env var.

import os
import struct
import sys
import time
from typing import Optional

import numpy as np


def log(msg: str) -> None:
    print(f"[ov-whisper] {msg}", file=sys.stderr, flush=True)


def read_exact(stream, n: int) -> Optional[bytes]:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def init_pipeline(model_dir, devices):
    import openvino_genai as ov_genai

    last_exc = None
    for device in devices:
        t0 = time.perf_counter()
        try:
            pipe = ov_genai.WhisperPipeline(model_dir, device)
            log(f"ready device={device} compile_ms={(time.perf_counter() - t0) * 1000.0:.0f}")
            return pipe, device
        except Exception as exc:  # noqa: BLE001 - try the next device in the chain
            log(f"device={device} init failed: {str(exc).splitlines()[0]}")
            last_exc = exc
    raise RuntimeError(f"all devices exhausted; last error: {last_exc}")


def main() -> int:
    model_dir = os.environ.get("ELIZA_OPENVINO_WHISPER_MODEL", "").strip()
    device_chain_env = os.environ.get("ELIZA_OPENVINO_WHISPER_DEVICE", "NPU,CPU").strip() or "NPU,CPU"
    devices = [d.strip() for d in device_chain_env.split(",") if d.strip()]
    if not model_dir or not os.path.isdir(model_dir):
        log(f"FATAL: ELIZA_OPENVINO_WHISPER_MODEL is missing or not a directory: {model_dir!r}")
        return 2

    try:
        import openvino_genai  # noqa: F401 - import-time failure surfaces here
    except Exception as exc:  # noqa: BLE001 - propagate any import failure
        log(f"FATAL: openvino_genai import failed: {exc}")
        return 3

    try:
        pipe, _ = init_pipeline(model_dir, devices)
    except Exception as exc:  # noqa: BLE001
        log(f"FATAL: {exc}")
        return 4

    config = pipe.get_generation_config()
    config.max_new_tokens = 200
    pipe.set_generation_config(config)

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    while True:
        header = read_exact(stdin, 4)
        if header is None:
            return 0
        (n_samples,) = struct.unpack("<I", header)
        if n_samples == 0:
            stdout.write(struct.pack("<I", 0))
            stdout.flush()
            continue
        payload = read_exact(stdin, n_samples * 4)
        if payload is None:
            log("stdin closed mid-payload")
            return 1

        pcm = np.frombuffer(payload, dtype="<f4")
        if pcm.size != n_samples:
            log(f"truncated payload: expected {n_samples} got {pcm.size}")
            return 1

        try:
            result = pipe.generate(pcm)
            text = str(result).strip()
        except Exception as exc:  # noqa: BLE001 - report as empty so the stream survives
            log(f"generate error: {exc}")
            text = ""

        encoded = text.encode("utf-8")
        stdout.write(struct.pack("<I", len(encoded)))
        stdout.write(encoded)
        stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
