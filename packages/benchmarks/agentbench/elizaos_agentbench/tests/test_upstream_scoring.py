"""
Integration tests for adapter scoring against upstream-format tasks.

These exercise the DB / KG / OS / LTP scoring paths using the real
upstream loaders and the deterministic ``SmartMockRuntime``. We don't
assert specific scores - the mock runtime is not a capable LLM - we
just verify the *scoring code* is exercised on upstream-format tasks
and produces well-formed results.
"""

import pytest

from elizaos_agentbench import upstream_loader as L
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter
from elizaos_agentbench.types import AgentBenchEnvironment as E


class TestDBOnUpstream:
    @pytest.mark.asyncio
    async def test_db_label_based_scoring(self) -> None:
        """The DB adapter should evaluate using the upstream label list."""
        tasks = L.load_db_tasks(split="dev", limit=1)
        assert tasks, "expected at least one upstream DB task"
        task = tasks[0]
        # The first dev task should be a SELECT-style entry with a label.
        assert task.metadata.get("type") in ("other", "SELECT")
        assert isinstance(task.metadata.get("label"), list)

        adapter = DatabaseEnvironmentAdapter()
        await adapter.initialize()
        obs = await adapter.reset(task)
        assert obs["tables"], "schema should be populated from upstream task"

        # Issue a benign SELECT (won't match the label, but the
        # scoring code path should execute cleanly and return False).
        _obs, _r, _done, _info = await adapter.step("SELECT 1 AS one;")
        scored = await adapter.evaluate(task, ["SELECT 1 AS one;"])
        assert scored is False
        await adapter.cleanup()

    @pytest.mark.asyncio
    async def test_db_normalize_special_values(self) -> None:
        """Match upstream's special-value normalization."""
        assert DatabaseEnvironmentAdapter._normalize_db_value(None) == "0"
        assert DatabaseEnvironmentAdapter._normalize_db_value("null") == "0"
        assert DatabaseEnvironmentAdapter._normalize_db_value("1,234") == "1234"
        assert DatabaseEnvironmentAdapter._normalize_db_value("12%") == "12"
        assert DatabaseEnvironmentAdapter._normalize_db_value(42) == "42"

    @pytest.mark.asyncio
    async def test_db_compare_float_tolerance(self) -> None:
        """Match upstream's 1e-2 float tolerance."""
        assert DatabaseEnvironmentAdapter._compare_db_values(["1.00"], ["1.005"]) is True
        assert DatabaseEnvironmentAdapter._compare_db_values(["1.0"], ["1.5"]) is False
        # Set-equality on string values.
        assert DatabaseEnvironmentAdapter._compare_db_values(["a", "b"], ["b", "a"]) is True


class TestKGOnUpstream:
    @pytest.mark.asyncio
    async def test_kg_loads_and_resets(self) -> None:
        tasks = L.load_kg_tasks(split="dev", limit=1)
        assert tasks
        task = tasks[0]

        adapter = KnowledgeGraphAdapter()
        await adapter.initialize()
        obs = await adapter.reset(task)
        # The adapter no longer ships a built-in graph; with upstream
        # KG data the local entity store stays empty (real benchmark
        # would query SPARQL).
        assert isinstance(obs, dict)
        assert "task_description" in obs

        # Evaluating without any answer trajectory should be False
        # and should not blow up.
        scored = await adapter.evaluate(task, [])
        assert scored is False
        await adapter.cleanup()


class TestLTPOnUpstream:
    @pytest.mark.asyncio
    async def test_ltp_loads_and_runs(self) -> None:
        tasks = L.load_ltp_tasks(split="dev", limit=1)
        assert tasks
        task = tasks[0]

        adapter = LateralThinkingAdapter()
        await adapter.initialize()
        obs = await adapter.reset(task)
        assert "scenario" in obs

        _obs, _r, _done, _info = await adapter.step("ask[Is this related to fear?]")
        # Submit a wrong guess - scoring code should run and return False.
        await adapter.step("guess[totally unrelated answer]")
        scored = await adapter.evaluate(task, ["ask[anything?]", "guess[totally unrelated answer]"])
        assert isinstance(scored, bool)
        await adapter.cleanup()
