"""WebShop evaluator.

WebShop's published metrics (Yao et al. 2022, Table 2):

- **Score**: mean reward across all instructions (continuous, 0..1).
- **SR (success rate)**: fraction of instructions where reward == 1.0
  (i.e., the agent's purchased product satisfies *all* goal attributes,
  *all* goal options, *and* the price constraint).

We surface both. The aggregate ``WebShopReport`` reports ``average_reward``
(Score) and ``success_rate`` (SR @ threshold 1.0).
"""

from __future__ import annotations

from elizaos_webshop.types import EpisodeStep, WebShopResult, WebShopTask

SUCCESS_THRESHOLD = 1.0


class WebShopEvaluator:
    def evaluate(
        self,
        *,
        task: WebShopTask,
        trial_number: int,
        purchased_product_id: str | None,
        reward: float,
        turns_used: int,
        duration_ms: float,
        steps: list[EpisodeStep],
        final_response: str,
        error: str | None = None,
    ) -> WebShopResult:
        # Following WebShop's SR metric (reward == 1.0 means the agent matched
        # title, attributes, options, and price).
        success = bool(
            purchased_product_id is not None and reward >= SUCCESS_THRESHOLD
        )
        return WebShopResult(
            task_id=task.task_id,
            trial_number=trial_number,
            success=success,
            purchased_product_id=purchased_product_id,
            reward=reward,
            turns_used=turns_used,
            duration_ms=duration_ms,
            steps=steps,
            final_response=final_response,
            error=error,
            tokens_used=0,
        )
