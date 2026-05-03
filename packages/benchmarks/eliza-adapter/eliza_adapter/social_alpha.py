"""Social-Alpha benchmark system backed by the eliza TS bridge.

Drop-in replacement for ``benchmark.systems.eliza_system.ElizaSystem`` that
routes the LLM-driven ``extract_recommendation`` call through the eliza
TypeScript benchmark HTTP server (``ElizaClient.send_message``) instead of
spinning up a Python ``AgentRuntime``.

The deterministic trust-scoring / leaderboard / scam-detection pieces are
left unchanged — they are pure-Python in-memory aggregations over the calls
fed in via ``process_call`` / ``update_price`` and do not require an LLM.

The system implements the same ``SocialAlphaSystem`` protocol that the
benchmark harness drives, with the same disk extraction cache so repeated
runs against the same dataset are cheap.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmark.protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore

logger = logging.getLogger(__name__)


def _social_alpha_protocol():
    """Lazy import of benchmark.protocol — avoids requiring the social-alpha package on sys.path at module load."""
    from benchmark.protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore

    return ExtractionResult, SocialAlphaSystem, UserTrustScore


def _social_alpha_state():
    """Lazy import of plugin in-process state used by the deterministic suites."""
    from benchmark.plugin import (
        _add_call,
        _classify_archetype,
        _compute_trust_score,
        _compute_user_metrics,
        _parse_extraction_json,
        _token_initial_prices,
        _token_worst_prices,
        _update_token_price,
        _user_calls,
        reset_plugin_state,
    )

    return {
        "_add_call": _add_call,
        "_classify_archetype": _classify_archetype,
        "_compute_trust_score": _compute_trust_score,
        "_compute_user_metrics": _compute_user_metrics,
        "_parse_extraction_json": _parse_extraction_json,
        "_token_initial_prices": _token_initial_prices,
        "_token_worst_prices": _token_worst_prices,
        "_update_token_price": _update_token_price,
        "_user_calls": _user_calls,
        "reset_plugin_state": reset_plugin_state,
    }


_EXTRACTION_PROMPT = (
    "You are a crypto trading signal extraction engine evaluated on the "
    "Social-Alpha benchmark. Given the chat message below, output a JSON "
    "object with EXACTLY these keys:\n"
    "  is_recommendation (boolean)\n"
    "  recommendation_type (\"BUY\" | \"SELL\" | \"NOISE\")\n"
    "  conviction (\"HIGH\" | \"MEDIUM\" | \"LOW\" | \"NONE\")\n"
    "  token_mentioned (ticker string or empty string)\n\n"
    "Rules:\n"
    "- If the message is not a trading recommendation, set is_recommendation=false, "
    "recommendation_type=\"NOISE\", conviction=\"NONE\".\n"
    "- token_mentioned is the bare ticker (e.g. \"BONK\"), no leading $.\n"
    "- Reply with ONLY the JSON object, no commentary, no markdown fences.\n\n"
    "Message:\n{message}"
)


def _build_class():
    """Build the ElizaBridgeSystem class lazily so import errors surface only when used."""
    ExtractionResult, SocialAlphaSystem, UserTrustScore = _social_alpha_protocol()

    class ElizaBridgeSystem(SocialAlphaSystem):
        """Social-Alpha system that delegates extraction to the eliza TS bridge.

        Replaces the in-process ``elizaos.AgentRuntime`` flow with HTTP calls
        to the TypeScript benchmark server. The deterministic trust-scoring
        machinery (in-memory call/price stores in ``benchmark.plugin``) is
        reused unchanged because it is pure Python and does not depend on
        the runtime.
        """

        def __init__(
            self,
            cache_dir: str | Path = ".benchmark_cache",
            model: str | None = None,
            client: ElizaClient | None = None,
        ) -> None:
            self._model = model or "eliza-ts-bridge"
            self._cache_dir = Path(cache_dir)
            self._cache_dir.mkdir(parents=True, exist_ok=True)

            self._cache: dict[str, dict[str, str | bool]] = {}
            self._cache_file = self._cache_dir / "eliza_bridge_extraction_cache.json"
            self._load_cache()

            self._client = client or ElizaClient()
            self._client_ready = False

            self._extract_calls = 0
            self._cache_hits = 0
            self._api_calls = 0
            self._start_time = time.time()

        # ------------------------------------------------------------------
        # Cache
        # ------------------------------------------------------------------

        def _load_cache(self) -> None:
            if self._cache_file.exists():
                with open(self._cache_file) as f:
                    self._cache = json.load(f)

        def _save_cache(self) -> None:
            with open(self._cache_file, "w") as f:
                json.dump(self._cache, f)

        def _cache_key(self, text: str) -> str:
            return hashlib.sha256(text.encode()).hexdigest()[:16]

        # ------------------------------------------------------------------
        # Bridge call
        # ------------------------------------------------------------------

        def _ensure_client(self) -> None:
            if self._client_ready:
                return
            self._client.wait_until_ready(timeout=120)
            self._client_ready = True

        def _extract_via_bridge(self, message_text: str) -> "ExtractionResult":
            self._ensure_client()

            prompt = _EXTRACTION_PROMPT.format(message=message_text[:1000])
            response = self._client.send_message(
                text=prompt,
                context={
                    "benchmark": "social_alpha",
                    "task": "extract_recommendation",
                    "model_name": self._model,
                    "message": message_text[:1000],
                },
            )

            state = _social_alpha_state()
            parser = state["_parse_extraction_json"]

            text = response.text or ""
            # Some agents wrap the JSON in <text>...</text> XML; strip if present.
            xml_text = re.search(r"<text>([\s\S]*?)</text>", text)
            if xml_text:
                text = xml_text.group(1).strip()

            parsed = parser(text)
            return ExtractionResult(
                is_recommendation=bool(parsed.get("is_recommendation", False)),
                recommendation_type=str(parsed.get("recommendation_type", "NOISE")),
                conviction=str(parsed.get("conviction", "NONE")),
                token_mentioned=str(parsed.get("token_mentioned", "")),
                token_address="",
            )

        # ------------------------------------------------------------------
        # SocialAlphaSystem protocol
        # ------------------------------------------------------------------

        def extract_recommendation(self, message_text: str) -> "ExtractionResult":
            self._extract_calls += 1
            key = self._cache_key(message_text)

            if key in self._cache:
                self._cache_hits += 1
                entry = self._cache[key]
                rec_type = str(entry.get("recommendation_type", "NOISE"))
                if rec_type not in ("BUY", "SELL", "NOISE"):
                    rec_type = "NOISE"
                conv = str(entry.get("conviction", "NONE"))
                if conv not in ("HIGH", "MEDIUM", "LOW", "NONE"):
                    conv = "NONE"
                is_rec = bool(entry.get("is_recommendation", False)) and rec_type != "NOISE"
                return ExtractionResult(
                    is_recommendation=is_rec,
                    recommendation_type=rec_type,
                    conviction=conv,
                    token_mentioned=str(entry.get("token_mentioned", "")),
                    token_address="",
                )

            result = self._extract_via_bridge(message_text)
            self._api_calls += 1

            self._cache[key] = {
                "is_recommendation": result.is_recommendation,
                "recommendation_type": result.recommendation_type,
                "conviction": result.conviction,
                "token_mentioned": result.token_mentioned,
            }

            if self._api_calls % 100 == 0:
                self._save_cache()
                elapsed = time.time() - self._start_time
                rate = self._api_calls / max(elapsed, 1)
                logger.info(
                    "[ElizaBridgeSystem] %s extractions | %s API | %s cache | %.1f/sec",
                    f"{self._extract_calls:,}",
                    self._api_calls,
                    self._cache_hits,
                    rate,
                )

            return result

        def process_call(
            self,
            user_id: str,
            token_address: str,
            recommendation_type: str,
            conviction: str,
            price_at_call: float,
            timestamp: int,
        ) -> None:
            state = _social_alpha_state()
            state["_add_call"](
                user_id, token_address, recommendation_type, conviction, price_at_call, timestamp
            )
            initial = state["_token_initial_prices"]
            if token_address not in initial:
                initial[token_address] = price_at_call

        def update_price(self, token_address: str, price: float, timestamp: int) -> None:
            _ = timestamp
            state = _social_alpha_state()
            state["_update_token_price"](token_address, price)

        def get_user_trust_score(self, user_id: str) -> "UserTrustScore | None":
            state = _social_alpha_state()
            user_calls = state["_user_calls"]
            if user_id not in user_calls:
                return None
            trust = state["_compute_trust_score"](user_id)
            metrics = state["_compute_user_metrics"](user_id)
            archetype = state["_classify_archetype"](user_id)
            return UserTrustScore(
                user_id=user_id,
                trust_score=trust,
                win_rate=float(metrics["win_rate"]),
                total_calls=len(user_calls[user_id]),
                archetype=archetype,
            )

        def get_leaderboard(self, top_k: int = 50) -> "list[UserTrustScore]":
            state = _social_alpha_state()
            user_calls = state["_user_calls"]
            scores: list[UserTrustScore] = []
            for uid in user_calls:
                score = self.get_user_trust_score(uid)
                if score is not None:
                    scores.append(score)
            scores.sort(key=lambda s: s.trust_score, reverse=True)
            return scores[:top_k]

        def is_scam_token(self, token_address: str) -> bool:
            state = _social_alpha_state()
            initial = state["_token_initial_prices"].get(token_address)
            worst = state["_token_worst_prices"].get(token_address)
            if initial is None or worst is None or initial <= 0:
                return False
            drop = ((worst - initial) / initial) * 100
            return drop <= -80

        def reset(self) -> None:
            state = _social_alpha_state()
            state["reset_plugin_state"]()

        # ------------------------------------------------------------------
        # Cache warming (serial; bridge handles its own concurrency)
        # ------------------------------------------------------------------

        def warm_cache(self, messages: list[str]) -> None:
            uncached = [m for m in messages if self._cache_key(m) not in self._cache]
            if not uncached:
                logger.info(
                    "[ElizaBridgeSystem] Cache already warm (%d entries)", len(self._cache)
                )
                return

            logger.info(
                "[ElizaBridgeSystem] Warming cache: %d messages (%d already cached)",
                len(uncached),
                len(self._cache),
            )

            for i, msg in enumerate(uncached):
                key = self._cache_key(msg)
                if key in self._cache:
                    continue
                result = self._extract_via_bridge(msg)
                self._api_calls += 1
                self._cache[key] = {
                    "is_recommendation": result.is_recommendation,
                    "recommendation_type": result.recommendation_type,
                    "conviction": result.conviction,
                    "token_mentioned": result.token_mentioned,
                }
                if (i + 1) % 100 == 0:
                    self._save_cache()
                    elapsed = time.time() - self._start_time
                    rate = (i + 1) / max(elapsed, 1)
                    remaining = (len(uncached) - i - 1) / max(rate, 0.1) / 60
                    logger.info(
                        "[ElizaBridgeSystem] Cache warm: %d/%d (%.1f msg/sec, ~%.0fm remaining)",
                        i + 1,
                        len(uncached),
                        rate,
                        remaining,
                    )

            self._save_cache()
            logger.info(
                "[ElizaBridgeSystem] Cache warm complete: %d total entries",
                len(self._cache),
            )

        def finalize(self) -> None:
            self._save_cache()
            pct = self._cache_hits / max(self._extract_calls, 1) * 100
            logger.info(
                "[ElizaBridgeSystem] Final: %d extractions, %d cache hits (%.0f%%), %d API, %d cached",
                self._extract_calls,
                self._cache_hits,
                pct,
                self._api_calls,
                len(self._cache),
            )

    return ElizaBridgeSystem


def make_eliza_bridge_social_alpha_system(
    cache_dir: str | Path = ".benchmark_cache",
    model: str | None = None,
    client: ElizaClient | None = None,
):
    """Build an ElizaBridgeSystem instance configured for the social-alpha harness."""
    cls = _build_class()
    return cls(cache_dir=cache_dir, model=model, client=client)


__all__ = ["make_eliza_bridge_social_alpha_system"]
