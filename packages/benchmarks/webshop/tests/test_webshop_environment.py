"""Smoke tests for the WebShop adapter.

These tests construct an in-memory ``WebShopEnvironment`` over the bundled
~6-product sample catalog and exercise the full upstream pipeline:

    load_products -> SimServer (BM25 fallback) -> WebAgentTextEnv ->
    map_action_to_html -> get_reward

Heavy dependencies (``spacy``, ``en_core_web_sm``, ``torch``, ``thefuzz``)
must be installed for the upstream Gym env to import. If they are missing,
the tests are skipped rather than failed so a freshly-cloned repo can still
``pytest -k webshop`` without surprises.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

# We do not depend on upstream being importable globally; the adapter inserts
# `upstream/` onto sys.path on demand.

_HEAVY_DEPS_OK: tuple[bool, str | None]


def _check_upstream_importable() -> tuple[bool, str | None]:
    benchmark_dir = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(benchmark_dir / "upstream"))
    try:
        import spacy  # noqa: F401
        # spaCy requires the en_core_web_sm model. It's auto-downloaded by
        # upstream's setup.sh but not by our pyproject. Probe for it.
        try:
            spacy.load("en_core_web_sm")
        except Exception as exc:
            return False, f"spaCy model 'en_core_web_sm' not available: {exc}"
        import torch  # noqa: F401
        import thefuzz  # noqa: F401
        import bs4  # noqa: F401
        from web_agent_site.engine.goal import get_reward  # noqa: F401
        from web_agent_site.envs.web_agent_text_env import WebAgentTextEnv  # noqa: F401
    except Exception as exc:
        return False, f"upstream WebShop dependency missing: {exc}"
    return True, None


_HEAVY_DEPS_OK = _check_upstream_importable()


pytestmark = pytest.mark.skipif(
    not _HEAVY_DEPS_OK[0],
    reason=(_HEAVY_DEPS_OK[1] or "upstream WebShop deps missing"),
)


# ---------------------------------------------------------------------------
# Direct reward-function test
# ---------------------------------------------------------------------------


def test_get_reward_is_upstream_tfidf_based() -> None:
    """`get_reward` is upstream's TF-IDF / fuzzy-match scorer.

    We assert that:
      1. The function comes from ``web_agent_site.engine.goal``.
      2. Its ``verbose=True`` info dict contains the upstream-specific keys
         (``r_type``, ``r_att``, ``query_match``, ``title_score``, ...),
         which are produced only by the published reward function.
    """
    from elizaos_webshop.environment import get_reward

    # Build a synthetic purchased product matching the sample catalog schema
    # required by upstream's get_reward (Title, Attributes, BulletPoints,
    # Description, product_category, name, query).
    purchased = {
        "asin": "B000HEADPH",
        "name": "Wireless Bluetooth Headphones Black",
        "Title": "Wireless Bluetooth Headphones Black",
        "Attributes": ["wireless", "bluetooth", "noise cancelling"],
        "BulletPoints": ["wireless", "bluetooth", "noise cancelling"],
        "Description": "Over-ear wireless bluetooth headphones.",
        "category": "electronics",
        "product_category": "Electronics > Headphones > Over-Ear",
        "query": "wireless bluetooth headphones",
    }
    goal = {
        "asin": "B000HEADPH",
        "name": "Wireless Bluetooth Headphones Black",
        "category": "electronics",
        "query": "wireless bluetooth headphones",
        "product_category": "Electronics > Headphones > Over-Ear",
        "instruction_text": "buy wireless bluetooth headphones in black",
        "attributes": ["wireless", "bluetooth", "noise cancelling"],
        "price_upper": 100.0,
        "goal_options": {"color": "black"},
    }
    options = {"color": "black"}

    reward, info = get_reward(purchased, goal, price=79.99, options=options, verbose=True)

    # Upstream-only keys (would not exist in our old custom scorer).
    assert "r_type" in info
    assert "r_att" in info
    assert "query_match" in info
    assert "title_score" in info
    # Mismatched fields are excluded; price + option weights only appear when
    # they're scored. We have both here.
    assert "r_option" in info
    assert "r_price" in info

    # Perfect match should hit the cap.
    assert 0.0 <= reward <= 1.0
    assert reward >= 0.5, f"unexpectedly low reward: {reward} ({info})"


# ---------------------------------------------------------------------------
# End-to-end mini-episode test
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def sample_env():
    """Construct a real WebShopEnvironment over the bundled sample catalog."""
    from elizaos_webshop.dataset import WebShopDataset
    from elizaos_webshop.environment import WebShopEnvironment

    ds = WebShopDataset(split="test", use_sample_tasks=True, human_goals=True)
    ds.load_sync()
    assert ds.paths is not None
    env = WebShopEnvironment(
        file_path=ds.paths.items,
        attr_path=ds.paths.attributes,
        human_attr_path=ds.paths.human_instructions,
        human_goals=True,
        observation_mode="text",
    )
    yield env, ds
    env.close()


def test_environment_reset_and_search(sample_env) -> None:
    env, ds = sample_env
    tasks = ds.get_tasks()
    assert tasks, "sample dataset produced no tasks"
    obs = env.reset(tasks[0])
    assert obs.message  # raw upstream observation string
    out = env.step("search[wireless bluetooth headphones]")
    assert isinstance(out.reward, float)
    assert out.done is False
    # Search results are reflected as clickable product-link entries.
    avail = env.available_actions
    assert any(a.lower().startswith("click[b000headph") for a in avail), (
        f"expected B000HEADPH among clickables, got {avail}"
    )


def test_mock_agent_runs_episode_to_completion(sample_env) -> None:
    """The deterministic mock agent should drive the upstream env to a
    terminal state (Buy Now), and the resulting reward must come from
    upstream's TF-IDF scorer (i.e., is a float in [0, 1] and the env's
    ``final_reward`` is populated)."""
    from elizaos_webshop.eliza_agent import MockWebShopAgent

    env, ds = sample_env
    # Pick a task whose target asin is one of our sample asins.
    tasks = [t for t in ds.get_tasks() if t.target_product_ids and t.target_product_ids[0].startswith("B000")]
    assert tasks, "no sample tasks with B000* targets"
    task = tasks[0]

    agent = MockWebShopAgent(env, max_turns=12)
    steps, _final, _obs = asyncio.run(agent.process_task(task))

    assert steps, "agent produced no steps"
    assert env.done, "agent failed to reach a terminal state"
    assert 0.0 <= env.final_reward <= 1.0
