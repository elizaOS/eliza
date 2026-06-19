#!/usr/bin/env python3
"""Minimal Cerebras (OpenAI-compatible) chat client used by the dataset builders.

The Cerebras inference API speaks the OpenAI `/v1/chat/completions` shape. We
do not pull in the `openai` SDK — a tiny `urllib` POST is all the dataset
synthesis scripts need.

Configuration (read from the environment, never hard-coded):

* ``CEREBRAS_API_KEY``  — required. The operator/agent exports it before
  running any builder that augments via Cerebras. No fallback, no default.
* ``CEREBRAS_BASE_URL`` — default ``https://api.cerebras.ai/v1``.
* ``CEREBRAS_MODEL``    — default ``gpt-oss-120b``.

Usage::

    from cerebras_client import CerebrasClient
    client = CerebrasClient()
    text = client.chat([
        {"role": "system", "content": "You are a careful data generator."},
        {"role": "user", "content": "Emit 3 JSONL rows ..."},
    ], temperature=0.7)

The client retries on 429 / 5xx with exponential backoff and raises
``CerebrasError`` on a hard failure — callers decide whether to skip the
augmentation step or abort. It never silently returns an empty string.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable

DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_MODEL = "gpt-oss-120b"


class CerebrasError(RuntimeError):
    """Raised when the Cerebras API call fails after retries."""


@dataclass
class CerebrasClient:
    api_key: str | None = None
    base_url: str = ""
    model: str = ""
    timeout_s: float = 120.0
    max_retries: int = 5

    def __post_init__(self) -> None:
        self.api_key = self.api_key or os.environ.get("CEREBRAS_API_KEY")
        if not self.api_key:
            raise CerebrasError(
                "CEREBRAS_API_KEY is not set. Export it before running a "
                "Cerebras-augmented dataset builder; the key is never stored "
                "in the repo."
            )
        self.base_url = (self.base_url or os.environ.get("CEREBRAS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.model = self.model or os.environ.get("CEREBRAS_MODEL") or DEFAULT_MODEL

    # -- internal -----------------------------------------------------------
    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8")
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "eliza1-sft-builder/1.0",
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:  # noqa: PERF203 - retry loop
                body = exc.read().decode("utf-8", errors="replace")
                if exc.code in (429, 500, 502, 503, 504) and attempt < self.max_retries - 1:
                    wait = min(2 ** attempt, 30)
                    time.sleep(wait)
                    last_err = CerebrasError(f"HTTP {exc.code}: {body[:300]}")
                    continue
                raise CerebrasError(f"HTTP {exc.code} from {url}: {body[:500]}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < self.max_retries - 1:
                    time.sleep(min(2 ** attempt, 30))
                    last_err = exc
                    continue
                raise CerebrasError(f"network error calling {url}: {exc}") from exc
        raise CerebrasError(f"exhausted retries calling {url}: {last_err}")

    # -- public -------------------------------------------------------------
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        top_p: float = 1.0,
        extra: dict[str, Any] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "top_p": top_p,
        }
        if extra:
            payload.update(extra)
        resp = self._post("/chat/completions", payload)
        try:
            choice = resp["choices"][0]
            msg = choice["message"]
            content = msg.get("content")
        except (KeyError, IndexError, TypeError) as exc:
            raise CerebrasError(f"unexpected response shape: {json.dumps(resp)[:500]}") from exc
        if (not isinstance(content, str) or not content.strip()) and choice.get("finish_reason") == "length":
            # gpt-oss-120b is a reasoning model: it spends tokens in `reasoning`
            # then emits the answer in `content`. Hitting the cap mid-thought
            # leaves content empty — surface that clearly so the caller can
            # retry with a higher max_tokens rather than treating it as content.
            raise CerebrasError(
                "Cerebras completion truncated before the answer (finish_reason=length); "
                f"raise max_tokens (was {max_tokens})."
            )
        if not isinstance(content, str) or not content.strip():
            raise CerebrasError(f"Cerebras returned an empty completion: {json.dumps(resp)[:300]}")
        return content

    def chat_json_lines(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> list[dict[str, Any]]:
        """Call ``chat`` and parse the response as JSONL (one object per line).

        Lines that are not valid JSON objects are skipped. Returns ``[]`` only
        when the model genuinely emitted nothing parseable — the caller logs
        and continues; an API failure still raises ``CerebrasError``.
        """
        raw = self.chat(messages, temperature=temperature, max_tokens=max_tokens)
        out: list[dict[str, Any]] = []
        for line in _iter_jsonish_lines(raw):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
            elif isinstance(obj, list):
                out.extend(x for x in obj if isinstance(x, dict))
        return out


def _iter_jsonish_lines(text: str) -> Iterable[str]:
    """Yield candidate JSON lines, tolerating ```json fences and prose."""
    text = text.strip()
    if "```" in text:
        # Pull the content of the first fenced block if present.
        parts = text.split("```")
        for i in range(1, len(parts), 2):
            block = parts[i]
            if block.startswith("json"):
                block = block[4:]
            text = block.strip()
            break
    for line in text.splitlines():
        line = line.strip().rstrip(",")
        if line and (line[0] in "[{"):
            yield line
    # Also try the whole blob as a single JSON document.
    if text and text[0] in "[{":
        yield text


if __name__ == "__main__":
    import sys

    c = CerebrasClient()
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Say 'ok' and nothing else."
    print(c.chat([{"role": "user", "content": prompt}], temperature=0.0, max_tokens=32))
