"""Groq Whisper STT client (HTTP, OpenAI-compatible).

Consistent with the existing latency benchmark's ``groq`` profile at
``packages/benchmarks/voicebench/`` — both use the same Groq transcription
endpoint, so a single shared model id keeps the two benchmarks
comparable.

We hit Groq directly via ``httpx`` rather than importing the ``groq``
SDK so this package has no extra heavy dependency for a single endpoint
call.
"""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("elizaos_voicebench.clients.groq_stt")

_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
_DEFAULT_MODEL = "whisper-large-v3-turbo"
_REQUEST_TIMEOUT_S = 60.0


class GroqWhisperClient:
    """Audio bytes → transcript via Groq's OpenAI-compatible API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        resolved = api_key or os.environ.get("GROQ_API_KEY", "").strip()
        if not resolved:
            raise RuntimeError(
                "GROQ_API_KEY is not set; required for VoiceBench cascaded STT."
            )
        self._api_key = resolved
        self._model = model or os.environ.get("VOICEBENCH_STT_MODEL") or _DEFAULT_MODEL
        self._base_url = (base_url or _GROQ_BASE_URL).rstrip("/")

    async def transcribe(self, audio: bytes) -> str:
        url = f"{self._base_url}/audio/transcriptions"
        files = {"file": ("sample.wav", audio, "audio/wav")}
        data = {"model": self._model, "response_format": "json"}
        headers = {"Authorization": f"Bearer {self._api_key}"}
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as http:
            resp = await http.post(url, headers=headers, files=files, data=data)
        resp.raise_for_status()
        payload = resp.json()
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            raise RuntimeError(f"Groq STT returned no text: {payload!r}")
        return text
