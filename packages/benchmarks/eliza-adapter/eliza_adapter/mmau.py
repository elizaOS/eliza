"""MMAU adapter bridge for Eliza, Hermes, and OpenClaw harnesses."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

from benchmarks.mmau.agent import format_mcq_prompt
from benchmarks.mmau.evaluator import choice_letters, extract_answer_letter
from benchmarks.mmau.types import MMAUConfig, MMAUPrediction, MMAUSample


_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
_DEFAULT_STT_MODEL = "whisper-large-v3-turbo"


class _BaseMMAUAgent:
    benchmark_name = "mmau"

    def __init__(self, config: MMAUConfig) -> None:
        self.config = config
        self._client: Any | None = None
        self._server_manager: Any | None = None

    async def initialize(self) -> None:
        self._client = self._build_client()
        wait = getattr(self._client, "wait_until_ready", None)
        if callable(wait):
            await asyncio.to_thread(wait, timeout=120)

    async def close(self) -> None:
        return None

    async def predict(self, sample: MMAUSample) -> MMAUPrediction:
        started = time.time()
        transcript = await self._transcribe(sample)
        prompt = format_mcq_prompt(sample, transcript=transcript)
        try:
            raw_answer = await asyncio.to_thread(self._send_prompt, sample, prompt)
            predicted = extract_answer_letter(
                raw_answer,
                valid_letters=choice_letters(sample.choices),
            )
            error = None
        except Exception as exc:  # noqa: BLE001 - benchmark boundary capture
            raw_answer = ""
            predicted = ""
            error = f"{type(exc).__name__}: {exc}"
        return MMAUPrediction(
            sample_id=sample.id,
            predicted_letter=predicted,
            raw_answer=raw_answer,
            raw_output={
                "mode": "cascaded_stt",
                "harness": self.harness_name,
                "prompt": prompt,
            },
            transcript=transcript,
            error=error,
            latency_ms=(time.time() - started) * 1000,
        )

    @property
    def harness_name(self) -> str:
        return self.__class__.__name__.replace("MMAUAgent", "").lower()

    def _build_client(self) -> Any:
        raise NotImplementedError

    def _send_prompt(self, sample: MMAUSample, prompt: str) -> str:
        if self._client is None:
            raise RuntimeError("MMAU adapter was not initialized")
        response = self._client.send_message(
            prompt,
            context={
                "benchmark": self.benchmark_name,
                "task_id": sample.id,
                "category": sample.category.value,
                "model_name": self.config.model or "",
                "system_prompt": (
                    "You are answering an audio-understanding multiple-choice "
                    "benchmark. Return only the option letter."
                ),
            },
        )
        return str(getattr(response, "text", ""))

    async def _transcribe(self, sample: MMAUSample) -> str:
        if sample.transcript:
            return sample.transcript
        if sample.audio_bytes is None:
            return ""
        api_key = os.environ.get("GROQ_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "MMAU full-audio runs require GROQ_API_KEY for cascaded STT; "
                "use fixture mode for text-only smoke runs."
            )
        model = (
            self.config.stt_model
            or os.environ.get("GROQ_TRANSCRIPTION_MODEL")
            or _DEFAULT_STT_MODEL
        )
        url = f"{_GROQ_BASE_URL}/audio/transcriptions"
        files = {"file": ("sample.wav", sample.audio_bytes, "audio/wav")}
        data = {"model": model, "response_format": "json"}
        headers = {"Authorization": f"Bearer {api_key}"}
        import httpx

        timeout_s = max(10.0, self.config.timeout_ms / 1000)
        async with httpx.AsyncClient(timeout=timeout_s) as http:
            resp = await http.post(url, headers=headers, files=files, data=data)
        resp.raise_for_status()
        payload = resp.json()
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError(f"Groq STT returned no transcript: {payload!r}")
        return text.strip()


class ElizaMMAUAgent(_BaseMMAUAgent):
    def _build_client(self) -> Any:
        if os.environ.get("ELIZA_BENCH_URL") and os.environ.get("ELIZA_BENCH_TOKEN"):
            from eliza_adapter.client import ElizaClient

            return ElizaClient()

        from eliza_adapter.server_manager import ElizaServerManager

        self._server_manager = ElizaServerManager()
        self._server_manager.start()
        return self._server_manager.client


class HermesMMAUAgent(_BaseMMAUAgent):
    def _build_client(self) -> Any:
        from hermes_adapter.client import HermesClient

        return HermesClient()


class OpenClawMMAUAgent(_BaseMMAUAgent):
    def _build_client(self) -> Any:
        from openclaw_adapter.client import OpenClawClient

        return OpenClawClient(
            direct_openai_compatible=True,
            allow_text_tool_calls=True,
        )
