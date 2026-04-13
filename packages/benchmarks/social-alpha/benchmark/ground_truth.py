"""
Ground Truth Generator for the Trust Marketplace Benchmark.

Takes the enriched Trenches Chat dataset and produces labeled ground truth
for all benchmark suites: EXTRACT, RANK, DETECT, PROFIT.

Ground truth is derived from **price outcomes**, not human opinion.
We don't need to know motivation — we measure whether following a call
would have made or lost money.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Literal

# ---------------------------------------------------------------------------
# Constants / Thresholds
# ---------------------------------------------------------------------------

# A call is a WIN if the best achievable price was >=5 % above called price
WIN_THRESHOLD_PCT = 5.0

# A call is a LOSS if the worst price was <=-10 % below called price
LOSS_THRESHOLD_PCT = -10.0

# A token is a RUG if it dropped >80 % from the called price
RUG_DROP_PCT = -80.0

# A token is a PUMP_DUMP if it rose >200 % then fell >70 % within the window
PUMP_RISE_PCT = 200.0
PUMP_FALL_PCT = -70.0

# Minimum calls on distinct tokens for a user to be "qualified"
MIN_CALLS_QUALIFIED = 5
MIN_TOKENS_QUALIFIED = 3

# Archetype thresholds
ALPHA_WIN_RATE = 0.65
ALPHA_AVG_PROFIT = 20.0
SOLID_WIN_RATE = 0.55
SOLID_AVG_PROFIT = 5.0
NOISE_WIN_RATE_BAND = 0.05  # within +/- 5 % of 50 %
RUG_PROMOTER_RATE = 0.30
FUD_NEGATIVE_RATE = 0.70
SCAM_HUNTER_NEGATIVE_RATE = 0.30
SCAM_HUNTER_WARN_RATE = 0.50
HIGH_VARIANCE_STD = 40.0


class Outcome(str, Enum):
    WIN = "WIN"
    LOSS = "LOSS"
    NEUTRAL = "NEUTRAL"


class RecType(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    NOISE = "NOISE"


class Difficulty(str, Enum):
    EASY = "EASY"
    MEDIUM = "MEDIUM"
    HARD = "HARD"


class Archetype(str, Enum):
    ALPHA_CALLER = "alpha_caller"
    SOLID_TRADER = "solid_trader"
    NOISE_MAKER = "noise_maker"
    RUG_PROMOTER = "rug_promoter"
    FUD_ARTIST = "fud_artist"
    SCAM_HUNTER = "scam_hunter"
    ONE_HIT_WONDER = "one_hit_wonder"
    DEGEN_GAMBLER = "degen_gambler"
    LOW_INFO = "low_info"


# ---------------------------------------------------------------------------
# Data classes for ground truth records
# ---------------------------------------------------------------------------


@dataclass
class CallGroundTruth:
    call_id: str
    message_id: str
    user_id: str
    username: str
    timestamp: int
    content: str

    # Extraction ground truth
    is_recommendation: bool
    recommendation_type: str  # BUY / SELL / NOISE
    conviction: str  # HIGH / MEDIUM / LOW / NONE
    token_mentioned: str
    token_address: str
    chain: str

    # Outcome ground truth (from price data)
    price_at_call: float
    best_price: float
    worst_price: float
    outcome: str  # WIN / LOSS / NEUTRAL
    profit_pct: float  # ideal profit/loss %

    # Token flags
    is_rug_token: bool
    is_pump_dump: bool

    # Extraction difficulty
    extraction_difficulty: str  # EASY / MEDIUM / HARD

    # Original LLM labels (for comparison)
    llm_sentiment: str
    llm_conviction: str
    llm_certainty: str
    llm_reasoning: str


@dataclass
class UserGroundTruth:
    user_id: str
    username: str
    total_calls: int
    total_messages: int
    tokens_called_count: int
    is_qualified: bool  # meets minimum thresholds

    # Performance ground truth
    actual_win_rate: float
    actual_avg_profit: float
    total_profit: float
    best_call_profit: float
    worst_call_profit: float
    profit_std: float

    # Ranking
    actual_rank: int  # computed after all users are processed
    rank_score: float  # avg_profit * sqrt(num_calls)

    # Classification
    is_trustworthy: bool
    archetype: str

    # Risk metrics
    rug_promotion_rate: float
    scam_warned_rate: float  # negative calls on rug tokens = good
    call_ids: list[str] = field(default_factory=list)


@dataclass
class TokenGroundTruth:
    address: str
    symbol: str
    chain: str
    call_count: int
    is_rug: bool
    is_pump_dump: bool
    max_gain_pct: float
    max_loss_pct: float


# ---------------------------------------------------------------------------
# Ground Truth Generator
# ---------------------------------------------------------------------------


def _classify_outcome(price_data: dict[str, float | int]) -> tuple[str, float]:
    """Classify a call outcome as WIN/LOSS/NEUTRAL from price data."""
    called = price_data.get("calledPrice", 0)
    if not called or called <= 0:
        return Outcome.NEUTRAL.value, 0.0

    best = price_data.get("bestPrice", called)
    worst = price_data.get("worstPrice", called)
    ideal_pct = price_data.get("idealProfitLossPercent", 0.0)

    best_pct = ((best - called) / called) * 100
    worst_pct = ((worst - called) / called) * 100

    if best_pct >= WIN_THRESHOLD_PCT:
        return Outcome.WIN.value, ideal_pct
    elif worst_pct <= LOSS_THRESHOLD_PCT:
        return Outcome.LOSS.value, ideal_pct
    else:
        return Outcome.NEUTRAL.value, ideal_pct


def _is_rug_token(price_data: dict[str, float | int]) -> bool:
    """Token dropped >80% from called price."""
    called = price_data.get("calledPrice", 0)
    worst = price_data.get("worstPrice", called)
    if not called or called <= 0:
        return False
    drop_pct = ((worst - called) / called) * 100
    return drop_pct <= RUG_DROP_PCT


def _is_pump_dump(price_data: dict[str, float | int]) -> bool:
    """Token rose >200% then fell >70% — simplified heuristic."""
    called = price_data.get("calledPrice", 0)
    best = price_data.get("bestPrice", called)
    worst = price_data.get("worstPrice", called)
    if not called or called <= 0:
        return False
    rise_pct = ((best - called) / called) * 100
    fall_from_peak = ((worst - best) / best) * 100 if best > 0 else 0
    return rise_pct >= PUMP_RISE_PCT and fall_from_peak <= PUMP_FALL_PCT


def _classify_rec_type(sentiment: str) -> str:
    """Map sentiment to recommendation type."""
    if sentiment == "positive":
        return RecType.BUY.value
    elif sentiment == "negative":
        return RecType.SELL.value
    return RecType.NOISE.value


def _classify_difficulty(content: str, sentiment: str, certainty: str) -> str:
    """Estimate extraction difficulty based on message characteristics."""
    content_lower = content.lower()
    word_count = len(content.split())

    # Easy: explicit buy/sell language, ticker mentioned with $
    explicit_signals = ["buy", "sell", "moon", "pump", "dump", "scam", "rug",
                        "bullish", "bearish", "long", "short", "ape", "degen"]
    has_dollar_sign = "$" in content
    has_explicit = sum(1 for s in explicit_signals if s in content_lower)

    if has_dollar_sign and has_explicit >= 2 and certainty == "high":
        return Difficulty.EASY.value
    elif has_explicit >= 1 or has_dollar_sign:
        return Difficulty.MEDIUM.value
    else:
        return Difficulty.HARD.value


def _map_conviction(conviction: str) -> str:
    """Normalize conviction values."""
    conv_upper = conviction.upper() if conviction else "NONE"
    if conv_upper in ("HIGH",):
        return "HIGH"
    if conv_upper in ("MEDIUM", "MED"):
        return "MEDIUM"
    if conv_upper in ("LOW",):
        return "LOW"
    return "NONE"


def _classify_archetype(
    win_rate: float,
    avg_profit: float,
    total_calls: int,
    profit_std: float,
    rug_rate: float,
    negative_rate: float,
    scam_warn_rate: float,
    token_count: int,
) -> str:
    """Assign a behavioral archetype based on quantitative patterns."""
    if rug_rate >= RUG_PROMOTER_RATE:
        return Archetype.RUG_PROMOTER.value

    if negative_rate >= SCAM_HUNTER_NEGATIVE_RATE and scam_warn_rate >= SCAM_HUNTER_WARN_RATE:
        return Archetype.SCAM_HUNTER.value

    if negative_rate >= FUD_NEGATIVE_RATE and token_count < 3:
        return Archetype.FUD_ARTIST.value

    if total_calls <= 3 and avg_profit > 50:
        return Archetype.ONE_HIT_WONDER.value

    if total_calls < MIN_CALLS_QUALIFIED:
        return Archetype.LOW_INFO.value

    if win_rate >= ALPHA_WIN_RATE and avg_profit >= ALPHA_AVG_PROFIT and rug_rate < 0.10:
        return Archetype.ALPHA_CALLER.value

    if win_rate >= SOLID_WIN_RATE and avg_profit >= SOLID_AVG_PROFIT:
        return Archetype.SOLID_TRADER.value

    if profit_std >= HIGH_VARIANCE_STD:
        return Archetype.DEGEN_GAMBLER.value

    if abs(win_rate - 0.50) <= NOISE_WIN_RATE_BAND and abs(avg_profit) < 5:
        return Archetype.NOISE_MAKER.value

    return Archetype.LOW_INFO.value


# ---------------------------------------------------------------------------
# Main generation function
# ---------------------------------------------------------------------------


def generate_ground_truth(data_dir: str | Path) -> dict[str, list[dict]]:
    """
    Generate complete ground truth from the Trenches Chat enriched dataset.

    Args:
        data_dir: Path to trenches-chat-dataset/data/ directory

    Returns:
        Dictionary with keys: "calls", "users", "tokens"
    """
    data_dir = Path(data_dir)

    # Load data
    print("[ground_truth] Loading calls.json ...")
    with open(data_dir / "calls.json", "r") as f:
        calls_raw: list[dict] = json.load(f)
    print(f"[ground_truth] Loaded {len(calls_raw):,} calls")

    with open(data_dir / "users.json", "r") as f:
        users_raw: list[dict] = json.load(f)
    print(f"[ground_truth] Loaded {len(users_raw):,} users")

    # Build user lookup
    user_lookup: dict[str, dict] = {u["user_id"]: u for u in users_raw}

    # -----------------------------------------------------------------------
    # Phase 1: Generate call-level ground truth
    # -----------------------------------------------------------------------
    print("[ground_truth] Generating call-level labels ...")
    call_labels: list[CallGroundTruth] = []
    token_stats: dict[str, dict] = {}  # address -> stats
    user_call_map: dict[str, list[CallGroundTruth]] = {}  # user_id -> calls

    for call in calls_raw:
        price_data = call.get("price_data")
        if not price_data or call.get("enrichment_status") != "success":
            continue

        called_price = price_data.get("calledPrice", 0)
        if not called_price or called_price <= 0:
            continue

        outcome, profit_pct = _classify_outcome(price_data)
        rug = _is_rug_token(price_data)
        pump_dump = _is_pump_dump(price_data)

        sentiment = call.get("sentiment", "neutral")
        conviction_raw = call.get("conviction", "low")
        certainty = call.get("certainty", "low")
        content = call.get("content", "")

        gt = CallGroundTruth(
            call_id=call["call_id"],
            message_id=call.get("message_id", ""),
            user_id=call["user_id"],
            username=call.get("username", ""),
            timestamp=call.get("timestamp", 0),
            content=content,
            is_recommendation=(sentiment != "neutral"),
            recommendation_type=_classify_rec_type(sentiment),
            conviction=_map_conviction(conviction_raw),
            token_mentioned=call.get("token_mentioned", ""),
            token_address=call.get("token_address", ""),
            chain=call.get("chain", "unknown"),
            price_at_call=called_price,
            best_price=price_data.get("bestPrice", called_price),
            worst_price=price_data.get("worstPrice", called_price),
            outcome=outcome,
            profit_pct=profit_pct,
            is_rug_token=rug,
            is_pump_dump=pump_dump,
            extraction_difficulty=_classify_difficulty(content, sentiment, certainty),
            llm_sentiment=sentiment,
            llm_conviction=conviction_raw,
            llm_certainty=certainty,
            llm_reasoning=call.get("llm_reasoning", ""),
        )
        call_labels.append(gt)

        # Accumulate per-user
        user_call_map.setdefault(gt.user_id, []).append(gt)

        # Accumulate per-token
        addr = gt.token_address
        if addr:
            if addr not in token_stats:
                token_stats[addr] = {
                    "address": addr,
                    "symbol": gt.token_mentioned,
                    "chain": gt.chain,
                    "call_count": 0,
                    "rug_count": 0,
                    "pump_dump_count": 0,
                    "gains": [],
                    "losses": [],
                }
            ts = token_stats[addr]
            ts["call_count"] += 1
            if rug:
                ts["rug_count"] += 1
            if pump_dump:
                ts["pump_dump_count"] += 1
            if profit_pct > 0:
                ts["gains"].append(profit_pct)
            else:
                ts["losses"].append(profit_pct)

    print(f"[ground_truth] Generated {len(call_labels):,} call labels")

    # -----------------------------------------------------------------------
    # Phase 2: Generate token-level ground truth
    # -----------------------------------------------------------------------
    print("[ground_truth] Generating token-level labels ...")
    token_labels: list[TokenGroundTruth] = []
    rug_tokens: set[str] = set()

    for addr, ts in token_stats.items():
        max_gain = max(ts["gains"]) if ts["gains"] else 0.0
        max_loss = min(ts["losses"]) if ts["losses"] else 0.0
        is_rug = ts["rug_count"] / ts["call_count"] > 0.5 if ts["call_count"] > 0 else False
        is_pd = ts["pump_dump_count"] / ts["call_count"] > 0.3 if ts["call_count"] > 0 else False

        if is_rug:
            rug_tokens.add(addr)

        token_labels.append(TokenGroundTruth(
            address=addr,
            symbol=ts["symbol"],
            chain=ts["chain"],
            call_count=ts["call_count"],
            is_rug=is_rug,
            is_pump_dump=is_pd,
            max_gain_pct=max_gain,
            max_loss_pct=max_loss,
        ))

    print(f"[ground_truth] Generated {len(token_labels):,} token labels ({len(rug_tokens)} rugs)")

    # -----------------------------------------------------------------------
    # Phase 3: Generate user-level ground truth
    # -----------------------------------------------------------------------
    print("[ground_truth] Generating user-level labels ...")
    user_labels: list[UserGroundTruth] = []

    for user_id, calls in user_call_map.items():
        user_info = user_lookup.get(user_id, {})
        total_messages = user_info.get("total_messages", 0)

        evaluated = [c for c in calls if c.outcome != Outcome.NEUTRAL.value]
        wins = [c for c in evaluated if c.outcome == Outcome.WIN.value]
        profits = [c.profit_pct for c in calls if c.profit_pct != 0]

        win_rate = len(wins) / len(evaluated) if evaluated else 0.0
        avg_profit = sum(profits) / len(profits) if profits else 0.0
        total_profit_val = sum(profits)
        best_profit = max(profits) if profits else 0.0
        worst_profit = min(profits) if profits else 0.0

        # Standard deviation (sample, N-1)
        if len(profits) > 1:
            mean_p = avg_profit
            variance = sum((p - mean_p) ** 2 for p in profits) / (len(profits) - 1)
            std_dev = math.sqrt(variance)
        else:
            std_dev = 0.0

        # Token diversity
        distinct_tokens = set(c.token_address for c in calls if c.token_address)

        # Rug promotion rate
        rug_calls = [c for c in calls if c.is_rug_token and c.recommendation_type == RecType.BUY.value]
        rug_rate = len(rug_calls) / len(calls) if calls else 0.0

        # Negative sentiment rate
        negative_calls = [c for c in calls if c.recommendation_type == RecType.SELL.value]
        negative_rate = len(negative_calls) / len(calls) if calls else 0.0

        # Scam warning rate (negative calls on rug tokens = GOOD)
        neg_on_rugs = [c for c in negative_calls if c.is_rug_token]
        scam_warn_rate = len(neg_on_rugs) / len(negative_calls) if negative_calls else 0.0

        is_qualified = len(calls) >= MIN_CALLS_QUALIFIED and len(distinct_tokens) >= MIN_TOKENS_QUALIFIED
        is_trustworthy = win_rate > 0.50 and avg_profit > 0 and is_qualified

        archetype = _classify_archetype(
            win_rate=win_rate,
            avg_profit=avg_profit,
            total_calls=len(calls),
            profit_std=std_dev,
            rug_rate=rug_rate,
            negative_rate=negative_rate,
            scam_warn_rate=scam_warn_rate,
            token_count=len(distinct_tokens),
        )

        # Rank score: combines avg profit with sample size
        rank_score = avg_profit * math.sqrt(len(calls)) if calls else 0.0

        user_labels.append(UserGroundTruth(
            user_id=user_id,
            username=calls[0].username if calls else "",
            total_calls=len(calls),
            total_messages=total_messages,
            tokens_called_count=len(distinct_tokens),
            is_qualified=is_qualified,
            actual_win_rate=round(win_rate, 4),
            actual_avg_profit=round(avg_profit, 4),
            total_profit=round(total_profit_val, 4),
            best_call_profit=round(best_profit, 4),
            worst_call_profit=round(worst_profit, 4),
            profit_std=round(std_dev, 4),
            actual_rank=0,  # filled below
            rank_score=round(rank_score, 4),
            is_trustworthy=is_trustworthy,
            archetype=archetype,
            rug_promotion_rate=round(rug_rate, 4),
            scam_warned_rate=round(scam_warn_rate, 4),
            call_ids=[c.call_id for c in calls],
        ))

    # Assign ranks (by rank_score descending, qualified users first)
    qualified = [u for u in user_labels if u.is_qualified]
    qualified.sort(key=lambda u: u.rank_score, reverse=True)
    for i, u in enumerate(qualified):
        u.actual_rank = i + 1

    unqualified = [u for u in user_labels if not u.is_qualified]
    for u in unqualified:
        u.actual_rank = len(qualified) + 1  # all unqualified share last rank

    print(f"[ground_truth] Generated {len(user_labels):,} user labels ({len(qualified)} qualified)")

    # -----------------------------------------------------------------------
    # Summary stats
    # -----------------------------------------------------------------------
    archetype_counts: dict[str, int] = {}
    for u in user_labels:
        archetype_counts[u.archetype] = archetype_counts.get(u.archetype, 0) + 1

    print("\n[ground_truth] === SUMMARY ===")
    print(f"  Calls labeled:  {len(call_labels):,}")
    print(f"  Tokens labeled: {len(token_labels):,} ({len(rug_tokens)} rugs)")
    print(f"  Users labeled:  {len(user_labels):,} ({len(qualified)} qualified)")
    print(f"  Archetypes:     {archetype_counts}")

    outcome_counts: dict[str, int] = {}
    for c in call_labels:
        outcome_counts[c.outcome] = outcome_counts.get(c.outcome, 0) + 1
    print(f"  Outcomes:       {outcome_counts}")

    return {
        "calls": [asdict(c) for c in call_labels],
        "users": [asdict(u) for u in user_labels],
        "tokens": [asdict(t) for t in token_labels],
    }


def save_ground_truth(ground_truth: dict[str, list[dict]], output_dir: str | Path) -> None:
    """Save ground truth to JSON files."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for key, data in ground_truth.items():
        path = output_dir / f"ground_truth_{key}.json"
        with open(path, "w") as f:
            json.dump(data, f, indent=2, default=str)
        print(f"[ground_truth] Saved {len(data):,} records to {path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    data_dir = sys.argv[1] if len(sys.argv) > 1 else "trenches-chat-dataset/data"
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "trenches-chat-dataset/data/ground_truth"

    gt = generate_ground_truth(data_dir)
    save_ground_truth(gt, output_dir)
    print("\n[ground_truth] Done.")
