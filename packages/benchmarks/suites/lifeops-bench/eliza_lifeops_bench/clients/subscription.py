"""Claude-subscription gateway client for LifeOps live evaluation.

The campaign gateway exposes an OpenAI-compatible endpoint, so this adapter
reuses the strict response parsing and retry behavior of the Cerebras client
while keeping gateway credentials and provider errors subscription-specific.
"""

from __future__ import annotations

import os

from .base import ClientCall, ClientResponse, ProviderError
from .cerebras import CerebrasClient


class ClaudeSubscriptionClient(CerebrasClient):
    """Run completions through the local provenance-bearing subscription gateway."""

    def __init__(self, model: str | None = None) -> None:
        token = os.environ.get("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", "").strip()
        base_url = (
            os.environ.get("OPENAI_BASE_URL", "").strip()
            or os.environ.get("CLAUDE_SUBSCRIPTION_GATEWAY_URL", "").strip()
        )
        if not token:
            raise ProviderError(
                "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN is not set; required for the subscription evaluator.",
                status=None,
                body=None,
                provider="claude-subscription",
            )
        if not base_url:
            raise ProviderError(
                "CLAUDE_SUBSCRIPTION_GATEWAY_URL/OPENAI_BASE_URL is not set; required for the subscription evaluator.",
                status=None,
                body=None,
                provider="claude-subscription",
            )
        normalized_base_url = base_url.rstrip("/")
        if not normalized_base_url.endswith("/v1"):
            normalized_base_url = f"{normalized_base_url}/v1"
        super().__init__(model=model, api_key=token, base_url=normalized_base_url)

    async def complete(self, call: ClientCall) -> ClientResponse:
        try:
            return await super().complete(call)
        except ProviderError as exc:
            # error-policy:J2 retain the wire failure while identifying the
            # subscription boundary that operators must inspect.
            raise ProviderError(
                str(exc),
                status=exc.status,
                body=exc.body,
                provider="claude-subscription",
            ) from exc
