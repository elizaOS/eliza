"""
Smoke tests for the vendored AgentBench upstream loader.

These verify that:
- the upstream data files exist and parse,
- per-env loaders produce well-formed AgentBenchTask objects,
- both dev and (truncated) test splits work,
- ground truth / metadata round-trip the upstream scoring contract.
"""

import pytest

from elizaos_agentbench import upstream_loader as L
from elizaos_agentbench.types import AgentBenchEnvironment as E
from elizaos_agentbench.types import AgentBenchTask


def _assert_valid_tasks(tasks: list[AgentBenchTask], env: E, expected_min: int = 1) -> None:
    assert isinstance(tasks, list)
    assert len(tasks) >= expected_min, f"expected >= {expected_min} tasks for {env.value}, got {len(tasks)}"
    for t in tasks:
        assert isinstance(t, AgentBenchTask)
        assert t.environment == env
        assert t.id
        assert t.description
        assert t.goal
        assert t.max_steps > 0
        assert t.timeout_ms > 0


class TestDatabaseLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_db_tasks(split="dev", limit=5)
        _assert_valid_tasks(tasks, E.DATABASE, expected_min=5)

    def test_test_split_truncated(self) -> None:
        tasks = L.load_db_tasks(split="test", limit=3)
        _assert_valid_tasks(tasks, E.DATABASE, expected_min=3)
        # Each db task carries the upstream "label" + type for scoring.
        for t in tasks:
            assert "type" in t.metadata
            assert "label" in t.metadata


class TestKnowledgeGraphLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_kg_tasks(split="dev", limit=5)
        _assert_valid_tasks(tasks, E.KNOWLEDGE_GRAPH, expected_min=5)
        # gold_ids / gold_names are needed for upstream's set-equality scoring.
        for t in tasks:
            assert "gold_ids" in t.metadata
            assert isinstance(t.metadata["gold_ids"], list)


class TestOSLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_os_tasks(split="dev", limit=3)
        _assert_valid_tasks(tasks, E.OS, expected_min=3)
        # Each task carries the upstream evaluation block (match / check).
        for t in tasks:
            assert "evaluation" in t.metadata


class TestLTPLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_ltp_tasks(split="dev", limit=3)
        _assert_valid_tasks(tasks, E.LATERAL_THINKING, expected_min=3)
        for t in tasks:
            assert t.ground_truth  # upstream "answer" / 汤底


class TestCardGameLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_card_game_tasks(split="dev")
        _assert_valid_tasks(tasks, E.CARD_GAME, expected_min=1)


class TestHouseholdingLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_householding_tasks(split="dev", limit=3)
        _assert_valid_tasks(tasks, E.HOUSEHOLDING, expected_min=1)
        for t in tasks:
            assert "game_file" in t.metadata


class TestWebBrowsingLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_web_browsing_tasks(split="dev", limit=3)
        _assert_valid_tasks(tasks, E.WEB_BROWSING, expected_min=1)


class TestWebShopLoader:
    def test_dev_split(self) -> None:
        tasks = L.load_webshop_tasks(split="dev", limit=3)
        _assert_valid_tasks(tasks, E.WEB_SHOPPING, expected_min=3)


class TestDispatcher:
    @pytest.mark.parametrize("env", list(E))
    def test_load_tasks_dev(self, env: E) -> None:
        tasks = L.load_tasks(env, split="dev", limit=2)
        assert isinstance(tasks, list)
        # Every env should at least yield a positive number of dev tasks
        # because we either have real upstream data or we expose stubs.
        assert len(tasks) > 0

    def test_invalid_split_raises(self) -> None:
        with pytest.raises(ValueError):
            L.load_db_tasks(split="train")
