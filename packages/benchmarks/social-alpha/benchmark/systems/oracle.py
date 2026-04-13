"""
Oracle System — Perfect-knowledge benchmark validator.

This system has access to the full ground truth and returns the exact
correct answers. It exists to verify that the benchmark scoring logic
is working correctly. A perfect oracle should score 100/100 on every suite.

If it doesn't, the scoring logic has a bug.
"""

from __future__ import annotations

from ..protocol import ExtractionResult, SocialAlphaSystem, UserTrustScore


class OracleSystem(SocialAlphaSystem):
    """
    Cheating system that looks up ground truth answers.
    Used ONLY for benchmark validation — not a real system.
    """

    def __init__(
        self,
        call_ground_truth: list[dict],
        user_ground_truth: list[dict],
        token_ground_truth: list[dict],
    ) -> None:
        self._call_gt = call_ground_truth
        self._user_gt = user_ground_truth
        self._token_gt = token_ground_truth

        # Build content -> ground truth lookup for EXTRACT suite.
        # Handle duplicate content by building a LIST per content string,
        # then consuming them in order (queue-based).
        self._content_queues: dict[str, list[dict]] = {}
        for call in call_ground_truth:
            content = call.get("content", "")
            if content:
                self._content_queues.setdefault(content, []).append(call)
        # Track position in each queue
        self._content_positions: dict[str, int] = {}

        # Build user_id -> ground truth lookup for RANK/DETECT suites
        self._user_by_id: dict[str, dict] = {u["user_id"]: u for u in user_ground_truth}

        # Build token address -> ground truth for DETECT suite
        self._token_by_addr: dict[str, dict] = {t["address"]: t for t in token_ground_truth}

        # Track calls received via process_call (for leaderboard)
        self._seen_user_ids: set[str] = set()

    def extract_recommendation(self, message_text: str) -> ExtractionResult:
        """Return exact ground truth labels for this message.

        Uses a queue per content string to handle duplicate messages correctly.
        The EXTRACT suite iterates call_ground_truth in order, calling this
        once per item. We consume the queue entries in the same order.
        """
        queue = self._content_queues.get(message_text)
        if not queue:
            return ExtractionResult(
                is_recommendation=False,
                recommendation_type="NOISE",
                conviction="NONE",
                token_mentioned="",
                token_address="",
            )

        pos = self._content_positions.get(message_text, 0)
        if pos < len(queue):
            gt = queue[pos]
            self._content_positions[message_text] = pos + 1
        else:
            # Queue exhausted — benchmark may be calling extract_recommendation
            # more times than expected for this content. Return last known good.
            import sys
            print(
                f"[Oracle WARNING] Queue exhausted for content (len={len(queue)}, pos={pos}): "
                f"{message_text[:60]}...",
                file=sys.stderr,
            )
            gt = queue[-1]

        return ExtractionResult(
            is_recommendation=gt.get("is_recommendation", False),
            recommendation_type=gt.get("recommendation_type", "NOISE"),
            conviction=gt.get("conviction", "NONE"),
            token_mentioned=gt.get("token_mentioned", ""),
            token_address=gt.get("token_address", ""),
        )

    def process_call(self, user_id: str, token_address: str, recommendation_type: str,
                     conviction: str, price_at_call: float, timestamp: int) -> None:
        """Track which users the harness tells us about."""
        self._seen_user_ids.add(user_id)

    def update_price(self, token_address: str, price: float, timestamp: int) -> None:
        """No-op — oracle already knows all prices."""
        pass

    def get_user_trust_score(self, user_id: str) -> UserTrustScore | None:
        """Return ground truth rank_score as trust_score, and correct archetype.

        Maps rank_score linearly to 0-100 to preserve perfect ordering.
        Trustworthy users are guaranteed to be above the median.
        """
        gt = self._user_by_id.get(user_id)
        if not gt:
            return None

        # Map rank_score to 0-100 using the actual_rank (which is rank-ordered).
        # This guarantees Spearman rho = 1.0 AND separates trustworthy/untrustworthy.
        qualified = [u for u in self._user_gt if u["is_qualified"]]
        n = len(qualified)
        if n == 0:
            return UserTrustScore(user_id=user_id, trust_score=50, win_rate=0, total_calls=0, archetype="low_info")

        # Rank-based linear score: rank 1 -> 100, rank N -> ~1
        rank = gt.get("actual_rank", n)
        trust = max(1.0, 100.0 - ((rank - 1) / max(n - 1, 1)) * 99.0)

        # For promoter detection: rug_promoters get score < 20
        if gt["archetype"] == "rug_promoter":
            trust = min(trust, 5.0)

        return UserTrustScore(
            user_id=user_id,
            trust_score=trust,
            win_rate=gt.get("actual_win_rate", 0),
            total_calls=gt.get("total_calls", 0),
            archetype=gt.get("archetype", "low_info"),
        )

    def get_leaderboard(self, top_k: int = 50) -> list[UserTrustScore]:
        """Return users ranked by ground truth rank_score."""
        qualified = [u for u in self._user_gt if u["is_qualified"] and u["user_id"] in self._seen_user_ids]
        if not qualified:
            # If no users seen yet, return all qualified users
            qualified = [u for u in self._user_gt if u["is_qualified"]]

        # Sort by rank_score descending (this IS the ground truth ordering)
        qualified.sort(key=lambda u: u["rank_score"], reverse=True)

        result = []
        for u in qualified[:top_k]:
            score = self.get_user_trust_score(u["user_id"])
            if score:
                result.append(score)
        return result

    def is_scam_token(self, token_address: str) -> bool:
        """Return ground truth rug status."""
        gt = self._token_by_addr.get(token_address)
        if not gt:
            return False
        return gt.get("is_rug", False)

    def reset(self) -> None:
        self._seen_user_ids.clear()
        self._content_positions.clear()
