from __future__ import annotations

from elizaos_webshop.types import EpisodeStep, WebShopResult, WebShopTask


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
        # For now, define success as perfect reward.
        success = bool(reward >= 1.0 and purchased_product_id is not None)
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

