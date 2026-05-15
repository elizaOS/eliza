"""Benchmark-quality patches for CompactBench case generation.

The upstream ``action_phrase`` lexicon intentionally contains engineering
anti-patterns such as disabling security controls and hardcoding credentials.
Those are useful as cautionary examples, but they make recall benchmarks ask
safety-tuned models to repeat unsafe instructions verbatim. For elizaOS runs
we own the benchmark quality, so we replace that generator with neutral
operational tasks that still test entity assignment and decision override
without triggering refusals.
"""

from __future__ import annotations


SAFE_ACTION_PHRASES: tuple[str, ...] = (
    "write the migration checklist",
    "prepare the rollout notes",
    "draft the customer update",
    "review the staging dashboard",
    "update the dependency inventory",
    "refresh the onboarding guide",
    "validate the invoice export",
    "archive the old feature flag",
    "document the API rate limits",
    "schedule the integration rehearsal",
    "compare the vendor proposals",
    "organize the release checklist",
    "label the monitoring alerts",
    "summarize the data retention policy",
    "map the permissions matrix",
    "verify the billing totals",
    "prepare the incident timeline",
    "update the launch calendar",
    "triage the support queue",
    "review the localization spreadsheet",
    "draft the QA handoff",
    "catalog the analytics events",
    "prepare the compliance packet",
    "reconcile the partner contacts",
    "update the training schedule",
)


def install_safe_action_phrase_generator() -> bool:
    """Install the safe ``action_phrase`` generator into CompactBench.

    Returns ``True`` when the upstream generator registry is available.
    """

    try:
        from compactbench.dsl.generators import LexiconGenerator, _REGISTRY
    except Exception:  # noqa: BLE001 - compactbench is an optional runtime dep.
        return False
    _REGISTRY["action_phrase"] = LexiconGenerator(
        name="action_phrase",
        lexicon=SAFE_ACTION_PHRASES,
    )
    return True


__all__ = ["SAFE_ACTION_PHRASES", "install_safe_action_phrase_generator"]
