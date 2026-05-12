"""
SmartBaseline — A significantly improved rule-based system.

No LLM calls. Uses:
  1. Expanded crypto-specific keyword + regex extraction
  2. Actual P&L tracking from price updates
  3. Archetype classification from computed user metrics
  4. Trust scores based on win rate, avg profit, and consistency

This demonstrates what's achievable with good heuristics alone.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict

from ..protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore

# ---------------------------------------------------------------------------
# Extraction patterns — tuned to real crypto Discord language
# ---------------------------------------------------------------------------

# Strong BUY signals (high conviction)
_BUY_STRONG = re.compile(
    r'\b(buy|buying|bought|ape|aped|aping|long|longing|bullish|moon|mooning|'
    r'100x|1000x|10x|pump|pumping|gem|alpha|accumulate|accumulating|load|loading|'
    r'send it|sending it|all in|going in|bags?|bagged|scooped?|scooping|'
    r'entry|entered|dip buy|btd|fomo|rocket|ripping|rip|calls?|called|'
    r'undervalued|cheap|early|still early|ez money|free money|no brainer|'
    r'next leg up|breakout|breaking out|reversal|bottomed)\b',
    re.IGNORECASE,
)

# Moderate BUY signals
_BUY_MODERATE = re.compile(
    r'\b(like|liking|watching|watching closely|eyes on|interested|looking at|'
    r'might buy|considering|potential|promising|solid|strong|good project|'
    r'holding|hold|hodl|nice|beautiful|chart looks|looks good)\b',
    re.IGNORECASE,
)

# Strong SELL / FUD signals
_SELL_STRONG = re.compile(
    r'\b(sell|selling|sold|dump|dumping|short|shorting|bearish|rug|rugged|'
    r'scam|scamming|trash|garbage|dead|dying|avoid|stay away|ponzi|'
    r'exit|exiting|take profit|tp|cut loss|stop loss|sl|'
    r'overvalued|overbought|top signal|toppy|crash|crashing|'
    r'fud|warning|careful|be careful|watch out|red flag|'
    r'rekt|wrecked|liquidated|honeypot)\b',
    re.IGNORECASE,
)

# Moderate SELL signals
_SELL_MODERATE = re.compile(
    r'\b(worried|concern|concerning|risky|risk|skeptical|doubt|'
    r'not sure|uncertain|weak|weakness|fading|fade|losing|'
    r'disappointed|bad|terrible|horrible|hate)\b',
    re.IGNORECASE,
)

# Token mention patterns
_TICKER_DOLLAR = re.compile(r'\$([A-Za-z][A-Za-z0-9]{1,10})\b')  # $SOL, $BTC
_TICKER_CAPS = re.compile(r'\b([A-Z][A-Z0-9]{1,9})\b')  # SOL, BTC (all caps, 2-10 chars)
_ADDRESS_SOL = re.compile(r'\b([1-9A-HJ-NP-Za-km-z]{32,44})\b')  # Solana base58

# Common non-token uppercase words to filter out
_NOT_TOKENS = {
    'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD',
    'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'DAY', 'GET', 'HAS', 'HIM', 'HIS',
    'HOW', 'ITS', 'LET', 'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO',
    'BOY', 'DID', 'ITS', 'SAY', 'SHE', 'TOO', 'USE', 'LOL', 'OMG', 'WTF',
    'IMO', 'TBH', 'NGL', 'IDK', 'SMH', 'TBD', 'FYI', 'RIP', 'GG', 'GM',
    'GN', 'LFG', 'DYOR', 'NFA', 'ATH', 'ATL', 'DCA', 'CEX', 'DEX', 'NFT',
    'DAO', 'TVL', 'APY', 'APR', 'ROI', 'PNL', 'OTC', 'KOL', 'TGE',
    'USD', 'EUR', 'GBP', 'JPY', 'BPS', 'MCAP', 'PUMP', 'DUMP',
    'YES', 'THIS', 'THAT', 'WHAT', 'WHEN', 'WHERE', 'JUST', 'LIKE',
    'BEEN', 'HAVE', 'WILL', 'WITH', 'FROM', 'THEY', 'BEEN', 'SOME',
    'THAN', 'THEM', 'THEN', 'VERY', 'MUCH', 'THINK', 'ABOUT',
}

# Known major tokens (always recognize these)
_KNOWN_TOKENS = {
    'SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'BNB', 'XRP', 'ADA', 'DOGE',
    'AVAX', 'DOT', 'LINK', 'MATIC', 'UNI', 'AAVE', 'SUSHI', 'CRV',
    'MKR', 'COMP', 'SNX', 'YFI', 'BONK', 'WIF', 'JUP', 'RAY', 'ORCA',
    'PEPE', 'SHIB', 'FLOKI', 'MEME', 'RENDER', 'FET', 'RNDR', 'AR',
    'NEAR', 'SUI', 'SEI', 'TIA', 'APT', 'OP', 'ARB', 'STRK',
}


def _extract_token(text: str) -> str:
    """Extract the most likely token ticker from message text."""
    # Priority 1: $TICKER format
    dollar_matches = _TICKER_DOLLAR.findall(text)
    for m in dollar_matches:
        return m.upper()

    # Priority 2: Known tokens mentioned
    words = set(text.upper().split())
    for token in _KNOWN_TOKENS:
        if token in words:
            return token

    # Priority 3: ALL_CAPS words that look like tickers (2-6 chars, not common words)
    caps_matches = _TICKER_CAPS.findall(text)
    for m in caps_matches:
        if m not in _NOT_TOKENS and 2 <= len(m) <= 6:
            return m

    return ""


def _score_sentiment(text: str) -> tuple[str, str]:
    """Score message sentiment and conviction.

    Returns: (recommendation_type, conviction)
    """
    buy_strong = len(_BUY_STRONG.findall(text))
    buy_mod = len(_BUY_MODERATE.findall(text))
    sell_strong = len(_SELL_STRONG.findall(text))
    sell_mod = len(_SELL_MODERATE.findall(text))

    buy_score = buy_strong * 2 + buy_mod
    sell_score = sell_strong * 2 + sell_mod

    if buy_score == 0 and sell_score == 0:
        return "NOISE", "NONE"

    if buy_score > sell_score:
        conv = "HIGH" if buy_strong >= 2 else ("MEDIUM" if buy_strong >= 1 else "LOW")
        return "BUY", conv
    elif sell_score > buy_score:
        conv = "HIGH" if sell_strong >= 2 else ("MEDIUM" if sell_strong >= 1 else "LOW")
        return "SELL", conv
    else:
        # Tie — default to the direction with the strong signal
        if buy_strong > sell_strong:
            return "BUY", "MEDIUM"
        elif sell_strong > buy_strong:
            return "SELL", "MEDIUM"
        return "NOISE", "NONE"


# ---------------------------------------------------------------------------
# User tracking
# ---------------------------------------------------------------------------

class _UserTracker:
    """Tracks a single user's calls and performance."""

    __slots__ = ('user_id', 'calls', 'total_profit', 'wins', 'losses',
                 'profits_list', 'tokens_seen', 'negative_calls', 'rug_calls')

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.calls: list[dict] = []  # {token, type, price, ts, best_price, worst_price}
        self.total_profit = 0.0
        self.wins = 0
        self.losses = 0
        self.profits_list: list[float] = []
        self.tokens_seen: set[str] = set()
        self.negative_calls = 0
        self.rug_calls = 0

    def add_call(self, token: str, rec_type: str, conviction: str, price: float, ts: int) -> None:
        self.calls.append({
            'token': token, 'type': rec_type, 'conviction': conviction,
            'price': price, 'ts': ts, 'best_price': price, 'worst_price': price,
            'profit': 0.0, 'settled': False,
        })
        self.tokens_seen.add(token)
        if rec_type == 'SELL':
            self.negative_calls += 1

    def update_price(self, token: str, price: float) -> None:
        for call in self.calls:
            if call['token'] != token or call['settled']:
                continue
            if call['price'] <= 0:
                continue

            # Track best/worst for this call
            call['best_price'] = max(call['best_price'], price)
            call['worst_price'] = min(call['worst_price'], price)

            # Compute profit based on type
            if call['type'] == 'BUY':
                pct = ((call['best_price'] - call['price']) / call['price']) * 100
            else:  # SELL
                # Good sell = price dropped after sell signal
                pct = ((call['price'] - call['worst_price']) / call['price']) * 100

            call['profit'] = pct

    def settle_all(self) -> None:
        """Finalize metrics from all calls."""
        self.total_profit = 0.0
        self.wins = 0
        self.losses = 0
        self.profits_list = []
        self.rug_calls = 0

        for call in self.calls:
            p = call['profit']
            self.profits_list.append(p)
            self.total_profit += p
            if p >= 5.0:
                self.wins += 1
            elif p <= -10.0:
                self.losses += 1

            # Check if this token rugged (dropped >80%)
            if call['price'] > 0:
                drop = ((call['worst_price'] - call['price']) / call['price']) * 100
                if drop <= -80 and call['type'] == 'BUY':
                    self.rug_calls += 1

    @property
    def num_calls(self) -> int:
        return len(self.calls)

    @property
    def win_rate(self) -> float:
        evaluated = self.wins + self.losses
        return self.wins / evaluated if evaluated > 0 else 0.5

    @property
    def avg_profit(self) -> float:
        return self.total_profit / self.num_calls if self.num_calls > 0 else 0.0

    @property
    def profit_std(self) -> float:
        if len(self.profits_list) < 2:
            return 0.0
        mean = self.avg_profit
        var = sum((p - mean) ** 2 for p in self.profits_list) / (len(self.profits_list) - 1)
        return math.sqrt(var)

    @property
    def negative_rate(self) -> float:
        return self.negative_calls / self.num_calls if self.num_calls else 0.0

    @property
    def rug_rate(self) -> float:
        return self.rug_calls / self.num_calls if self.num_calls else 0.0

    def classify_archetype(self) -> str:
        """Classify user archetype from computed metrics."""
        if self.num_calls < 5 or len(self.tokens_seen) < 3:
            return "low_info"

        wr = self.win_rate
        ap = self.avg_profit
        std = self.profit_std
        nr = self.negative_rate
        rr = self.rug_rate

        if rr >= 0.30:
            return "rug_promoter"
        if nr >= 0.30 and rr == 0:  # many negative calls, none on rugs — could be scam_hunter or fud_artist
            if nr >= 0.70 and len(self.tokens_seen) < 3:
                return "fud_artist"
            return "noise_maker"
        if self.num_calls <= 3 and ap > 50:
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
        """Compute a trust score from 0-100."""
        if self.num_calls == 0:
            return 50.0

        self.settle_all()

        # Base from win rate (0-40 points)
        wr_score = self.win_rate * 40

        # Profit component (0-30 points)
        if self.avg_profit >= 20:
            profit_score = 30
        elif self.avg_profit >= 5:
            profit_score = 15 + (self.avg_profit - 5) * (15 / 15)
        elif self.avg_profit >= 0:
            profit_score = 10 + self.avg_profit * (5 / 5)
        else:
            profit_score = max(0, 10 + self.avg_profit * 0.3)

        # Consistency (0-15 points) — lower std = more consistent
        if self.profit_std < 10:
            consistency_score = 15
        elif self.profit_std < 30:
            consistency_score = 15 - (self.profit_std - 10) * (10 / 20)
        else:
            consistency_score = max(0, 5 - (self.profit_std - 30) * 0.1)

        # Volume (0-15 points) — log scale, more calls = more data = more reliable
        vol_score = min(15, math.log2(max(self.num_calls, 1)) * 3)

        trust = wr_score + profit_score + consistency_score + vol_score

        # Penalty for rug promotion
        if self.rug_rate > 0.1:
            trust *= (1 - self.rug_rate)

        return max(0, min(100, trust))


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

class SmartBaselineSystem(SocialAlphaSystem):
    """
    Improved rule-based system with crypto-specific extraction,
    P&L tracking, and archetype classification.
    """

    def __init__(self) -> None:
        self._users: dict[str, _UserTracker] = {}
        self._token_prices: dict[str, float] = {}  # latest price per token
        self._token_is_rug: dict[str, bool] = {}
        self._token_initial_price: dict[str, float] = {}

    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        rec_type, conviction = _score_sentiment(message_text)
        token = _extract_token(message_text)

        is_rec = rec_type != "NOISE"

        # If we found a token but no sentiment, still mark as recommendation with LOW conviction
        if token and not is_rec:
            # Check if the message is about the token at all (at least mentions it)
            if len(message_text.split()) >= 3:  # not just a single word
                is_rec = True
                rec_type = "BUY"  # default to positive in crypto chat
                conviction = "LOW"

        return ExtractionResult(
            is_recommendation=is_rec,
            recommendation_type=rec_type,
            conviction=conviction,
            token_mentioned=token,
            token_address="",  # no resolution without API
        )

    def process_call(self, user_id: str, token_address: str, recommendation_type: str,
                     conviction: str, price_at_call: float, timestamp: int) -> None:
        if user_id not in self._users:
            self._users[user_id] = _UserTracker(user_id)

        self._users[user_id].add_call(token_address, recommendation_type, conviction,
                                       price_at_call, timestamp)

        # Track initial price for rug detection
        if token_address not in self._token_initial_price:
            self._token_initial_price[token_address] = price_at_call

    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        self._token_prices[token_address] = price

        # Update all users who have calls on this token
        for user in self._users.values():
            user.update_price(token_address, price)

        # Check for rug
        initial = self._token_initial_price.get(token_address, price)
        if initial > 0:
            drop = ((price - initial) / initial) * 100
            if drop <= -80:
                self._token_is_rug[token_address] = True

    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        user = self._users.get(user_id)
        if not user:
            return None

        trust = user.compute_trust_score()
        archetype = user.classify_archetype()

        return UserTrustScore(
            user_id=user_id,
            trust_score=trust,
            win_rate=user.win_rate,
            total_calls=user.num_calls,
            archetype=archetype,
        )

    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        # Settle all users
        for user in self._users.values():
            user.settle_all()

        scores = []
        for uid, user in self._users.items():
            score = self.get_user_trust_score(uid)
            if score:
                scores.append(score)
        scores.sort(key=lambda s: s.trust_score, reverse=True)
        return scores[:top_k]

    def is_scam_token(self, token_address: str) -> bool:
        return self._token_is_rug.get(token_address, False)

    def reset(self) -> None:
        self._users.clear()
        self._token_prices.clear()
        self._token_is_rug.clear()
        self._token_initial_price.clear()
