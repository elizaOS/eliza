"""
FullSystem — Production-quality benchmark system using real LLM extraction
and the balanced trust score algorithm from plugin-social-alpha.

Uses:
  1. OpenAI LLM for message extraction (cached to disk)
  2. Balanced trust score calculator (ported from TypeScript plugin)
  3. Price-based P&L tracking from benchmark-provided price updates
  4. Archetype classification matching ground truth methodology

This is the REAL system — not a toy baseline.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
from pathlib import Path

from ..protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore

# ---------------------------------------------------------------------------
# LLM Extraction with disk caching
# ---------------------------------------------------------------------------

_EXTRACTION_PROMPT_SINGLE = """You are analyzing a Discord message from a cryptocurrency trading community.
Determine if this message contains a trading recommendation (shill/FUD).

Message: "{message}"

Respond with ONLY a JSON object (no markdown, no explanation):
{{
  "is_recommendation": true/false,
  "recommendation_type": "BUY" or "SELL" or "NOISE",
  "conviction": "HIGH" or "MEDIUM" or "LOW" or "NONE",
  "token_mentioned": "TICKER" or "",
  "reasoning": "brief explanation"
}}

Rules:
- BUY = positive sentiment (bullish, shilling, recommending purchase)
- SELL = negative sentiment (bearish, FUD, warning against)
- NOISE = general discussion, questions, no clear recommendation
- Token should be the ticker symbol (e.g. SOL, BTC, BONK) or empty if none mentioned
- Conviction: HIGH = very confident/urgent, MEDIUM = moderate, LOW = casual mention, NONE = no recommendation
- If someone just mentions a token in passing without clear buy/sell intent, mark as NOISE"""


_EXTRACTION_PROMPT_BATCH = """You are analyzing Discord messages from a crypto trading community called "trenches".
For EACH message, determine if it contains a trading recommendation (shill or FUD).

IMPORTANT context:
- Users post contract addresses (CAs) like "FQ1tyso61AH1tzodyJfSwmzsD3GToybbRNoZxUBz21p8" to share tokens
- Users post dexscreener/solscan URLs containing the CA
- They discuss tokens by ticker ($BONK, $WIF) or by name ("mango", "alice", "degenai")
- When someone posts a CA or URL, they're usually SHILLING it (implicit BUY unless they say otherwise)
- This is a Solana-focused community, most tokens are SPL/pump.fun tokens

{ticker_context}

Messages:
{messages_block}

Respond with ONLY a JSON array — one object per message, in the SAME ORDER:
[
  {{"idx": 0, "is_recommendation": true/false, "recommendation_type": "BUY"/"SELL"/"NOISE", "conviction": "HIGH"/"MEDIUM"/"LOW"/"NONE", "token_mentioned": "TICKER"}},
  ...
]

Classification rules:
BUY examples (positive/shilling):
  "Boys load up on mango 🖨️🖨️ guaranteed printer" → BUY, HIGH, MANGO
  "FQ1tyso61AH...p8 This coin has a clear path up" → BUY, HIGH (the CA IS the token)
  "Im all in for alice" → BUY, HIGH, ALICE
  "yesterday I consolidated my dust into it on a dip" → BUY, MEDIUM
  "https://solscan.io/token/9KinN5..." → BUY, LOW (posting a CA/URL = implicit shill)
  "just aped" → BUY, MEDIUM (if a token is being discussed)

SELL/FUD examples (negative/warning):
  "Dodo dead" → SELL, HIGH, DODO
  "shit dumped idk why" → SELL, MEDIUM
  "so INC was a total bomb?" → SELL, LOW, INC
  "this is a scam dont buy" → SELL, HIGH
  "Who killed UoS again" → SELL, MEDIUM, UOS

NOISE examples (no recommendation):
  "Donald Trump Pnut 😂" → NOISE (just a comment)
  "what's the CA?" → NOISE (asking, not recommending)
  "gm everyone" → NOISE
  Questions about a token without expressing opinion → NOISE

- If someone posts a CA or URL without negative context, it's a LOW conviction BUY (they're sharing it because they think it's worth looking at)
- Token field should be the TICKER SYMBOL (not the full CA)
- You MUST return exactly {count} objects"""


class _ExtractionCache:
    """Persistent disk cache for LLM extraction results."""

    def __init__(self, cache_dir: str | Path) -> None:
        self._dir = Path(cache_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._mem: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        cache_file = self._dir / "extraction_cache.json"
        if cache_file.exists():
            with open(cache_file) as f:
                self._mem = json.load(f)

    def save(self) -> None:
        cache_file = self._dir / "extraction_cache.json"
        with open(cache_file, "w") as f:
            json.dump(self._mem, f)

    def get(self, text: str) -> dict | None:
        key = hashlib.sha256(text.encode()).hexdigest()[:16]
        return self._mem.get(key)

    def put(self, text: str, result: dict) -> None:
        key = hashlib.sha256(text.encode()).hexdigest()[:16]
        self._mem[key] = result

    @property
    def size(self) -> int:
        return len(self._mem)


def _call_openai(message: str, model: str, api_key: str) -> dict:
    """Call OpenAI API for extraction. Returns parsed JSON result."""
    import urllib.request
    import urllib.error

    prompt = _EXTRACTION_PROMPT_SINGLE.format(message=message.replace('"', '\\"')[:500])

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 200,
    }).encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            content = data["choices"][0]["message"]["content"]
            content = content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1].rsplit("```", 1)[0]
            return json.loads(content)
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limited
                time.sleep(2 ** attempt)
                continue
            return _error_result(f"HTTP {e.code}: {e.reason}")
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
                continue
            return _error_result(str(e))
    return _error_result("Max retries exceeded")


def _call_openai_batch_parallel(messages: list[str], model: str, api_key: str) -> list[dict]:
    """Call OpenAI for multiple messages concurrently using threads (1 call per message)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    results: list[dict] = [_error_result("not processed")] * len(messages)
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {}
        for i, msg in enumerate(messages):
            fut = pool.submit(_call_openai, msg, model, api_key)
            futures[fut] = i
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                results[idx] = fut.result()
            except Exception as e:
                results[idx] = _error_result(str(e))
    return results


def _call_openai_batch_single(
    messages: list[str], model: str, api_key: str,
    ticker_watch: dict[str, int] | None = None,
) -> list[dict]:
    """Send multiple messages in ONE API call and parse the array response.

    This is ~10-20x cheaper and faster than individual calls.
    Batch size should be 10-20 messages for best results.
    """
    import urllib.request

    messages_block = "\n".join(
        f'[{i}] "{msg[:200]}"' for i, msg in enumerate(messages)
    )

    # Build ticker context from the watch list
    ticker_context = ""
    if ticker_watch:
        top_tickers = sorted(ticker_watch.items(), key=lambda x: -x[1])[:30]
        if top_tickers:
            ticker_list = ", ".join(f"{t} ({n}x)" for t, n in top_tickers)
            ticker_context = f"Known active tickers in this community: {ticker_list}"

    prompt = _EXTRACTION_PROMPT_BATCH.format(
        messages_block=messages_block,
        count=len(messages),
        ticker_context=ticker_context,
    )

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 150 * len(messages),  # ~150 tokens per message result
    }).encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
            content = data["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            results_list = json.loads(content)
            if not isinstance(results_list, list):
                return [_error_result("Expected array")] * len(messages)

            # Map results back to messages by idx
            out: list[dict] = [_error_result("missing")] * len(messages)
            for item in results_list:
                idx = item.get("idx", -1)
                if 0 <= idx < len(messages):
                    out[idx] = {
                        "is_recommendation": item.get("is_recommendation", False),
                        "recommendation_type": item.get("recommendation_type", "NOISE"),
                        "conviction": item.get("conviction", "NONE"),
                        "token_mentioned": item.get("token_mentioned", ""),
                        "reasoning": item.get("reasoning", ""),
                    }
            return out
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
                continue
            return [_error_result(str(e))] * len(messages)

    return [_error_result("Max retries")] * len(messages)


def _error_result(reason: str) -> dict:
    return {
        "is_recommendation": False,
        "recommendation_type": "NOISE",
        "conviction": "NONE",
        "token_mentioned": "",
        "reasoning": f"Error: {reason}",
    }


# ---------------------------------------------------------------------------
# User tracking with balanced trust scoring
# ---------------------------------------------------------------------------

class _UserState:
    """Per-user state for tracking calls and computing trust."""

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.calls: list[dict] = []
        self.tokens_seen: set[str] = set()
        self.negative_calls = 0

    def add_call(self, token: str, rec_type: str, conviction: str, price: float, ts: int) -> None:
        self.calls.append({
            "token": token, "type": rec_type, "conviction": conviction,
            "price": price, "ts": ts, "best_price": price, "worst_price": price,
        })
        self.tokens_seen.add(token)
        if rec_type == "SELL":
            self.negative_calls += 1

    def update_price(self, token: str, price: float) -> None:
        for c in self.calls:
            if c["token"] == token:
                c["best_price"] = max(c["best_price"], price)
                c["worst_price"] = min(c["worst_price"], price)

    def _profits(self) -> list[float]:
        result = []
        for c in self.calls:
            if c["price"] <= 0:
                continue
            if c["type"] == "BUY":
                pct = ((c["best_price"] - c["price"]) / c["price"]) * 100
            else:
                pct = ((c["price"] - c["worst_price"]) / c["price"]) * 100
            result.append(pct)
        return result

    def compute_metrics(self) -> dict:
        profits = self._profits()
        n = len(profits)
        if n == 0:
            return {"win_rate": 0.5, "avg_profit": 0, "std": 0, "sharpe": 0,
                    "wins": 0, "losses": 0, "rug_rate": 0, "negative_rate": 0,
                    "good_calls": 0, "rug_promotions": 0}

        wins = sum(1 for p in profits if p >= 5)
        losses = sum(1 for p in profits if p <= -10)
        evaluated = wins + losses
        win_rate = wins / evaluated if evaluated > 0 else 0.5
        avg_profit = sum(profits) / n
        mean = avg_profit
        std = math.sqrt(sum((p - mean) ** 2 for p in profits) / max(n - 1, 1)) if n > 1 else 0
        sharpe = mean / std if std > 0 else 0

        # Rug detection
        rug_calls = 0
        good_calls = 0
        for c in self.calls:
            if c["price"] <= 0:
                continue
            drop = ((c["worst_price"] - c["price"]) / c["price"]) * 100
            if drop <= -80 and c["type"] == "BUY":
                rug_calls += 1
            gain = ((c["best_price"] - c["price"]) / c["price"]) * 100
            if gain >= 20:
                good_calls += 1

        return {
            "win_rate": win_rate, "avg_profit": avg_profit, "std": std,
            "sharpe": sharpe, "wins": wins, "losses": losses,
            "rug_rate": rug_calls / n if n > 0 else 0,
            "negative_rate": self.negative_calls / len(self.calls) if self.calls else 0,
            "good_calls": good_calls, "rug_promotions": rug_calls,
        }

    def classify_archetype(self) -> str:
        if len(self.calls) < 5 or len(self.tokens_seen) < 3:
            return "low_info"

        m = self.compute_metrics()
        wr, ap, std = m["win_rate"], m["avg_profit"], m["std"]
        rr, nr = m["rug_rate"], m["negative_rate"]

        if rr >= 0.30:
            return "rug_promoter"
        if nr >= 0.30 and m["rug_rate"] == 0:
            if nr >= 0.70 and len(self.tokens_seen) < 3:
                return "fud_artist"
        if len(self.calls) <= 3 and ap > 50:
            return "one_hit_wonder"
        if wr >= 0.65 and ap >= 20.0 and rr < 0.10:
            return "alpha_caller"
        if wr >= 0.55 and ap >= 5.0:
            return "solid_trader"
        if std >= 40.0:
            return "degen_gambler"
        if abs(wr - 0.50) <= 0.05 and abs(ap) < 5:
            return "noise_maker"
        return "low_info"

    def compute_trust_score(self) -> float:
        """Balanced trust score using the same algorithm as plugin-social-alpha."""
        m = self.compute_metrics()
        n = len(self.calls)
        if n == 0:
            return 50.0

        archetype = self.classify_archetype()

        # Use the balanced calculator logic (ported from Python plugin)
        from elizaos_plugin_social_alpha.trust_score import (
            TrustScoreMetrics, calculate_balanced_trust_score,
        )

        metrics = TrustScoreMetrics(
            total_calls=n,
            profitable_calls=m["wins"],
            average_profit=m["avg_profit"],
            win_rate=m["win_rate"],
            sharpe_ratio=m["sharpe"],
            alpha=m["avg_profit"],  # simplified: alpha ≈ avg_profit vs market avg of 0
            volume_penalty=0,
            consistency=max(0, 1 - m["std"] / 100) if m["std"] > 0 else 1.0,
        )

        return calculate_balanced_trust_score(
            metrics, archetype, m["rug_promotions"], m["good_calls"], n,
        )


# ---------------------------------------------------------------------------
# Full System
# ---------------------------------------------------------------------------

class FullSystem(SocialAlphaSystem):
    """
    Production benchmark system:
    - OpenAI LLM for extraction (with persistent disk cache)
    - Balanced trust score algorithm from plugin-social-alpha
    - Real P&L tracking from price updates
    - Archetype classification matching ground truth methodology
    """

    def __init__(self, cache_dir: str | Path = ".benchmark_cache",
                 model: str = "gpt-4o-mini") -> None:
        self._api_key = os.environ.get("OPENAI_API_KEY", "")
        self._model = model  # explicit model, don't trust env for this
        if not self._api_key:
            raise RuntimeError("OPENAI_API_KEY not set in environment")

        self._cache = _ExtractionCache(cache_dir)
        self._users: dict[str, _UserState] = {}
        self._token_initial_prices: dict[str, float] = {}
        self._token_worst_prices: dict[str, float] = {}

        # Dynamic ticker watch — learned from $TICKER mentions and CAs in messages
        self._ticker_watch: dict[str, int] = {}  # ticker -> mention count
        self._ca_to_ticker: dict[str, str] = {}  # contract address -> ticker
        self._ticker_to_ca: dict[str, str] = {}  # ticker -> contract address

        self._extract_calls = 0
        self._cache_hits = 0
        self._api_calls = 0
        self._start_time = time.time()

    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        self._extract_calls += 1

        import re

        # --- Learn from every message: $TICKER, CAs, URLs ---
        # 1. $TICKER mentions
        dollar_tickers = re.findall(r'\$([A-Za-z][A-Za-z0-9]{1,10})\b', message_text)
        for t in dollar_tickers:
            t_upper = t.upper()
            self._ticker_watch[t_upper] = self._ticker_watch.get(t_upper, 0) + 1

        # 2. Solana contract addresses (base58, 32-44 chars)
        cas_in_msg = re.findall(r'[1-9A-HJ-NP-Za-km-z]{32,44}', message_text)

        # 3. CAs in URLs (dexscreener, solscan, birdeye)
        url_cas = re.findall(r'(?:dexscreener\.com|solscan\.io|birdeye\.so)/[^\s]*?([1-9A-HJ-NP-Za-km-z]{32,44})', message_text)
        cas_in_msg.extend(url_cas)

        # 4. Link $TICKER to CA when both appear in same message
        if dollar_tickers and cas_in_msg:
            ticker = dollar_tickers[0].upper()
            ca = cas_in_msg[0]
            if ca not in self._ca_to_ticker:
                self._ca_to_ticker[ca] = ticker
                self._ticker_to_ca[ticker] = ca

        # Check cache first
        cached = self._cache.get(message_text)
        if cached:
            self._cache_hits += 1
            result = self._parse_result(cached)
            # Enrich with ticker watch if LLM missed the token
            if not result.token_mentioned:
                result = self._enrich_with_ticker_watch(message_text, result)
            return result

        # Call LLM
        self._api_calls += 1
        result_raw = _call_openai(message_text, self._model, self._api_key)
        self._cache.put(message_text, result_raw)

        # Progress + save cache periodically
        if self._api_calls % 100 == 0:
            self._cache.save()
            elapsed = time.time() - self._start_time if hasattr(self, '_start_time') else 0
            rate = self._api_calls / max(elapsed, 1)
            remaining = (28000 - self._extract_calls) / max(rate, 0.1) / 60
            print(f"  [FullSystem] {self._extract_calls:,}/{28491} | "
                  f"{self._api_calls} API calls | {self._cache_hits} cache hits | "
                  f"{rate:.1f}/sec | ~{remaining:.0f}m remaining",
                  flush=True)

        result = self._parse_result(result_raw)
        # Enrich with ticker watch if LLM missed the token
        if not result.token_mentioned:
            result = self._enrich_with_ticker_watch(message_text, result)
        return result

    def _enrich_with_ticker_watch(self, text: str, result: ExtractionResult) -> ExtractionResult:
        """If the LLM didn't identify a token, check if any watched tickers appear in the text."""
        text_upper = text.upper()
        best_ticker = ""
        best_count = 0
        for ticker, count in self._ticker_watch.items():
            # Only match tickers we've seen at least 3 times via $TICKER
            if count >= 3 and ticker in text_upper.split():
                if count > best_count:
                    best_ticker = ticker
                    best_count = count
        if best_ticker:
            return ExtractionResult(
                is_recommendation=result.is_recommendation,
                recommendation_type=result.recommendation_type,
                conviction=result.conviction,
                token_mentioned=best_ticker,
                token_address=result.token_address,
            )
        return result

    def _parse_result(self, result: dict) -> ExtractionResult:
        rec_type = result.get("recommendation_type", "NOISE")
        if rec_type not in ("BUY", "SELL", "NOISE"):
            rec_type = "NOISE"
        conv = result.get("conviction", "NONE")
        if conv not in ("HIGH", "MEDIUM", "LOW", "NONE"):
            conv = "NONE"
        return ExtractionResult(
            is_recommendation=result.get("is_recommendation", False) and rec_type != "NOISE",
            recommendation_type=rec_type,
            conviction=conv,
            token_mentioned=result.get("token_mentioned", ""),
            token_address="",
        )

    def process_call(self, user_id: str, token_address: str, recommendation_type: str,
                     conviction: str, price_at_call: float, timestamp: int) -> None:
        if user_id not in self._users:
            self._users[user_id] = _UserState(user_id)
        self._users[user_id].add_call(token_address, recommendation_type, conviction,
                                       price_at_call, timestamp)
        if token_address not in self._token_initial_prices:
            self._token_initial_prices[token_address] = price_at_call

    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        for user in self._users.values():
            user.update_price(token_address, price)

        worst = self._token_worst_prices.get(token_address, price)
        self._token_worst_prices[token_address] = min(worst, price)

    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        user = self._users.get(user_id)
        if not user:
            return None
        return UserTrustScore(
            user_id=user_id,
            trust_score=user.compute_trust_score(),
            win_rate=user.compute_metrics()["win_rate"],
            total_calls=len(user.calls),
            archetype=user.classify_archetype(),
        )

    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        scores = []
        for uid in self._users:
            score = self.get_user_trust_score(uid)
            if score:
                scores.append(score)
        scores.sort(key=lambda s: s.trust_score, reverse=True)
        return scores[:top_k]

    def is_scam_token(self, token_address: str) -> bool:
        initial = self._token_initial_prices.get(token_address)
        worst = self._token_worst_prices.get(token_address)
        if not initial or not worst or initial <= 0:
            return False
        drop = ((worst - initial) / initial) * 100
        return drop <= -80

    def reset(self) -> None:
        self._users.clear()
        self._token_initial_prices.clear()
        self._token_worst_prices.clear()
        # DON'T clear cache — it persists across resets

    def warm_cache(self, messages: list[str], use_batch: bool = True) -> None:
        """Pre-populate cache. Uses batch mode (15 msgs per API call) by default.

        Batch mode: ~1,900 API calls for 28K messages (vs 28K individual calls).
        About 10-15x cheaper and faster.
        """
        # Pre-scan ALL messages to build ticker watch before LLM calls
        import re as _re
        for msg in messages:
            for t in _re.findall(r'\$([A-Za-z][A-Za-z0-9]{1,10})\b', msg):
                t_upper = t.upper()
                self._ticker_watch[t_upper] = self._ticker_watch.get(t_upper, 0) + 1
            cas = _re.findall(r'[1-9A-HJ-NP-Za-km-z]{32,44}', msg)
            tickers = _re.findall(r'\$([A-Za-z][A-Za-z0-9]{1,10})\b', msg)
            if tickers and cas:
                self._ca_to_ticker[cas[0]] = tickers[0].upper()
                self._ticker_to_ca[tickers[0].upper()] = cas[0]

        print(f"  [FullSystem] Ticker watch: {len(self._ticker_watch)} tickers, "
              f"{len(self._ca_to_ticker)} CA→ticker mappings", flush=True)

        uncached = [m for m in messages if not self._cache.get(m)]
        if not uncached:
            print(f"  [FullSystem] Cache already warm ({self._cache.size} entries)")
            return

        from concurrent.futures import ThreadPoolExecutor, as_completed

        msgs_per_call = 15 if use_batch else 1
        concurrent_calls = 5 if use_batch else 20
        mode = "batch" if use_batch else "individual"
        api_calls_est = (len(uncached) + msgs_per_call - 1) // msgs_per_call
        print(f"  [FullSystem] Warming cache ({mode}): {len(uncached):,} messages, "
              f"~{api_calls_est:,} API calls, {concurrent_calls} concurrent", flush=True)

        # Split into sub-batches of msgs_per_call
        sub_batches: list[list[str]] = []
        for i in range(0, len(uncached), msgs_per_call):
            sub_batches.append(uncached[i:i + msgs_per_call])

        done_msgs = 0
        with ThreadPoolExecutor(max_workers=concurrent_calls) as pool:
            futures = {}
            for sb_idx, sb in enumerate(sub_batches):
                if use_batch and len(sb) > 1:
                    fut = pool.submit(_call_openai_batch_single, sb, self._model, self._api_key, self._ticker_watch)
                else:
                    fut = pool.submit(lambda m: [_call_openai(m[0], self._model, self._api_key)], sb)
                futures[fut] = (sb_idx, sb)

            for fut in as_completed(futures):
                sb_idx, sb = futures[fut]
                try:
                    results = fut.result()
                    for msg, result in zip(sb, results):
                        self._cache.put(msg, result)
                    self._api_calls += 1
                    done_msgs += len(sb)
                except Exception as e:
                    done_msgs += len(sb)
                    print(f"  [FullSystem] Batch {sb_idx} error: {e}", flush=True)

                if self._api_calls % 10 == 0:
                    self._cache.save()
                    elapsed = time.time() - self._start_time
                    rate = done_msgs / max(elapsed, 1)
                    remaining = (len(uncached) - done_msgs) / max(rate, 0.1) / 60
                    print(f"  [FullSystem] Cache warm: {done_msgs:,}/{len(uncached):,} "
                          f"({rate:.1f} msg/sec, {self._api_calls} API calls, "
                          f"~{remaining:.0f}m remaining)", flush=True)

        self._cache.save()
        print(f"  [FullSystem] Cache warm complete: {self._cache.size} total entries, "
              f"{self._api_calls} API calls total", flush=True)

    def finalize(self) -> None:
        """Save cache to disk. Call after benchmark run."""
        self._cache.save()
        print(f"\n  [FullSystem] Final stats: {self._extract_calls} extractions, "
              f"{self._cache_hits} cache hits ({self._cache_hits/max(self._extract_calls,1)*100:.0f}%), "
              f"{self._api_calls} API calls, {self._cache.size} cached total")
