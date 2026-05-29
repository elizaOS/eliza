"""tau-bench agent backed by the Smithers harness.

tau-bench's agent loop (``solve`` / ``_one_turn`` / history scrubbing) is
harness-agnostic — it drives ``self.client.send_message`` with a full message
list. We subclass the hermes tau agent and inject a :class:`SmithersClient`,
reusing the entire loop. (``hermes-adapter`` is always on the benchmark
PYTHONPATH alongside the other adapters.)
"""

from __future__ import annotations

from smithers_adapter.client import SmithersClient


def _make_smithers_tau_agent_cls():
    from hermes_adapter.tau_bench import HermesTauAgent

    class SmithersTauAgent(HermesTauAgent):
        def __init__(
            self,
            model: str = "gpt-oss-120b",
            provider: str = "cerebras",
            temperature: float = 0.0,
            client=None,
            mode: str | None = None,
        ) -> None:
            super().__init__(
                model=model,
                provider=provider,
                temperature=temperature,
                client=client
                or SmithersClient(provider=provider, model=model, temperature=temperature),
            )

    return SmithersTauAgent


# Lazily constructed so importing this module never requires hermes_adapter
# unless tau-bench actually instantiates the agent.
def SmithersTauAgent(*args, **kwargs):  # noqa: N802 — factory mimics a class
    return _make_smithers_tau_agent_cls()(*args, **kwargs)


__all__ = ["SmithersTauAgent"]
