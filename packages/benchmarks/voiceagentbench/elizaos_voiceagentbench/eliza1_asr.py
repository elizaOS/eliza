"""eliza-1 llama.cpp ASR backend.

Transcribes audio by shelling out to eliza-1's ``llama-mtmd-cli`` (the
multimodal CLI from the eliza-1 llama.cpp fork) with the ASR GGUF model and
its multimodal projector. This is the only local ASR path the voice
benchmarks use; faster-whisper and Groq Whisper are not involved.

The CLI prints the transcript to stdout wrapped in ``<asr_text>...`` and
prefixed with a ``language <name>`` token, e.g.::

    \\nlanguage English<asr_text>The quick brown fox.\\n\\n\\n

``parse_asr_output`` extracts just the transcript from that envelope.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

# Default install locations for the eliza-1 llama.cpp fork + ASR bundle.
_DEFAULT_BIN_DIR = "~/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused"
_DEFAULT_ASR_DIR = "~/.eliza/local-inference/models/eliza-1-2b.bundle/asr"

_ASR_TEXT_RE = re.compile(r"<asr_text>(.*?)(?:</asr_text>|\Z)", re.DOTALL)


def _resolve_path(value: str) -> Path:
    return Path(value).expanduser()


def resolve_binary() -> Path:
    """Locate the ``llama-mtmd-cli`` binary."""
    explicit = os.environ.get("ELIZA1_ASR_CLI", "").strip()
    if explicit:
        return _resolve_path(explicit)
    bin_dir = _resolve_path(os.environ.get("ELIZA1_LLAMA_BIN_DIR", _DEFAULT_BIN_DIR))
    return bin_dir / "llama-mtmd-cli"


def resolve_model() -> Path:
    explicit = os.environ.get("ELIZA1_ASR_MODEL", "").strip()
    if explicit:
        return _resolve_path(explicit)
    return _resolve_path(os.environ.get("ELIZA1_ASR_DIR", _DEFAULT_ASR_DIR)) / "eliza-1-asr.gguf"


def resolve_mmproj() -> Path:
    explicit = os.environ.get("ELIZA1_ASR_MMPROJ", "").strip()
    if explicit:
        return _resolve_path(explicit)
    return _resolve_path(os.environ.get("ELIZA1_ASR_DIR", _DEFAULT_ASR_DIR)) / "eliza-1-asr-mmproj.gguf"


def build_command(
    *, binary: Path, model: Path, mmproj: Path, audio_path: Path, prompt: str, n_predict: int
) -> list[str]:
    """Construct the ``llama-mtmd-cli`` argv for one transcription."""
    return [
        str(binary),
        "-m",
        str(model),
        "--mmproj",
        str(mmproj),
        "--audio",
        str(audio_path),
        "-p",
        prompt,
        "-n",
        str(n_predict),
        "--no-perf",
    ]


def parse_asr_output(stdout: str) -> str:
    """Extract the transcript from the CLI's ``<asr_text>`` envelope."""
    match = _ASR_TEXT_RE.search(stdout)
    text = match.group(1) if match else stdout
    return text.strip()


class Eliza1ASRBackend:
    """Local eliza-1 ASR backend over real audio bytes via ``llama-mtmd-cli``.

    Missing audio, a missing binary/model, a non-zero CLI exit, or an empty
    transcript are hard failures so the benchmark never silently falls back to
    a ground-truth transcript.
    """

    def __init__(
        self,
        *,
        binary: Path | None = None,
        model: Path | None = None,
        mmproj: Path | None = None,
        prompt: str | None = None,
        n_predict: int | None = None,
    ) -> None:
        self._binary = binary or resolve_binary()
        self._model = model or resolve_model()
        self._mmproj = mmproj or resolve_mmproj()
        self._prompt = prompt or os.environ.get("ELIZA1_ASR_PROMPT", "Transcribe the audio.")
        env_n = os.environ.get("ELIZA1_ASR_N_PREDICT", "").strip()
        self._n_predict = n_predict if n_predict is not None else (int(env_n) if env_n else 256)

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        # The fork's binaries link against sibling .dylibs in the bin dir.
        lib_dir = str(self._binary.parent)
        existing = env.get("DYLD_LIBRARY_PATH", "")
        env["DYLD_LIBRARY_PATH"] = f"{lib_dir}:{existing}" if existing else lib_dir
        return env

    def transcribe_bytes(self, audio: bytes, *, language: str | None = None) -> str:
        if audio is None:
            raise RuntimeError(
                "audio bytes are required; refusing to use a ground-truth "
                "transcript as eliza-1 ASR output."
            )
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            fh.write(audio)
            audio_path = Path(fh.name)
        try:
            cmd = build_command(
                binary=self._binary,
                model=self._model,
                mmproj=self._mmproj,
                audio_path=audio_path,
                prompt=self._prompt,
                n_predict=self._n_predict,
            )
            proc = subprocess.run(
                cmd,
                env=self._env(),
                capture_output=True,
                text=True,
                timeout=300,
            )
        finally:
            audio_path.unlink(missing_ok=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"eliza-1 llama-mtmd-cli failed (exit {proc.returncode}): "
                f"{proc.stderr.strip()[-2000:]}"
            )
        text = parse_asr_output(proc.stdout)
        if not text:
            raise RuntimeError(
                f"eliza-1 ASR returned an empty transcript; stdout={proc.stdout!r}"
            )
        return text
