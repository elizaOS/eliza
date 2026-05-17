"""
Tests for auto-download / auto-spawn logic in the gated environment adapters.

Covers:

- WebShop: AgentBench adapter routes through ``elizaos_webshop`` when the
  package is importable, and falls back to the smart-mock runtime when it
  isn't.
- Householding: ``ensure_alfworld_data`` invokes ``alfworld-download`` via
  subprocess when the package is installed but data is missing, and respects
  ``AGENTBENCH_NO_AUTOFETCH``.
- Knowledge Graph: ``_try_start_virtuoso`` only runs ``docker run`` when
  ``AGENTBENCH_KG_SPARQL_AUTOSTART=1`` and the docker CLI is on PATH.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from elizaos_agentbench.adapters import (
    householding_adapter as hh_mod,
    kg_adapter as kg_mod,
    webshop_adapter as ws_mod,
)
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
)


# ---------------------------------------------------------------------------
# WebShop bridge wiring
# ---------------------------------------------------------------------------


class _FakePageObservation:
    def __init__(self, message: str = "fake page", actions: list[str] | None = None) -> None:
        self.message = message
        self.available_actions = actions or ["search[<query>]"]


class _FakeStepOutcome:
    def __init__(self, *, reward: float, done: bool) -> None:
        self.observation = _FakePageObservation(message="step")
        self.reward = reward
        self.done = done
        self.info: dict = {}


class _FakeWebShopEnvironment:
    """Stand-in for ``elizaos_webshop.environment.WebShopEnvironment``."""

    def __init__(self, *args, **kwargs) -> None:  # noqa: D401
        self._instr = "Buy a fake widget"
        self.purchased_product_id = "B000FAKE"

    @property
    def instruction_text(self) -> str:
        return self._instr

    def reset(self, task) -> _FakePageObservation:  # noqa: ARG002
        return _FakePageObservation(message="welcome")

    def step(self, action: str) -> _FakeStepOutcome:  # noqa: ARG002
        return _FakeStepOutcome(reward=1.0, done=True)


class _FakeWebShopTask:
    def __init__(self, idx: int) -> None:
        self.task_id = f"ws-fake-{idx}"
        self.instruction = "find a widget"
        self.budget = 100.0


class _FakeWebShopDataset:
    """Stand-in for ``elizaos_webshop.dataset.WebShopDataset``."""

    def __init__(self, **kwargs) -> None:  # noqa: D401
        self.paths = types.SimpleNamespace(
            items=Path("/tmp/items.json"),
            attributes=Path("/tmp/attrs.json"),
            human_instructions=Path("/tmp/human.json"),
            has_human_goals=False,
        )
        self.tasks: list[_FakeWebShopTask] = [_FakeWebShopTask(i) for i in range(3)]

    def load_sync(self) -> None:
        return None

    def get_tasks(self) -> list[_FakeWebShopTask]:
        return list(self.tasks)


@pytest.fixture(autouse=True)
def _reset_module_caches():
    ws_mod._reset_elizaos_webshop_bridge_for_tests()
    hh_mod._reset_alfworld_setup_for_tests()
    kg_mod._reset_kg_sparql_for_tests()
    yield
    ws_mod._reset_elizaos_webshop_bridge_for_tests()
    hh_mod._reset_alfworld_setup_for_tests()
    kg_mod._reset_kg_sparql_for_tests()


class TestWebShopBridge:
    @pytest.mark.asyncio
    async def test_bridge_used_when_elizaos_webshop_importable(self) -> None:
        """When elizaos_webshop loads cleanly, the adapter routes through it."""
        fake_dataset_mod = types.ModuleType("elizaos_webshop.dataset")
        fake_dataset_mod.WebShopDataset = _FakeWebShopDataset
        fake_env_mod = types.ModuleType("elizaos_webshop.environment")
        fake_env_mod.WebShopEnvironment = _FakeWebShopEnvironment
        fake_pkg = types.ModuleType("elizaos_webshop")

        with patch.dict(sys.modules, {
            "elizaos_webshop": fake_pkg,
            "elizaos_webshop.dataset": fake_dataset_mod,
            "elizaos_webshop.environment": fake_env_mod,
        }):
            adapter = ws_mod.WebShopEnvironmentAdapter()
            await adapter.initialize()
            assert adapter._bridge_env is not None
            assert isinstance(adapter._bridge_env, _FakeWebShopEnvironment)
            assert adapter._bridge_tasks is not None
            assert len(adapter._bridge_tasks) == 3

            task = AgentBenchTask(
                id="ws-test-0000",
                environment=AgentBenchEnvironment.WEB_SHOPPING,
                description="Buy a widget",
                initial_state={"webshop_index": 1, "split": "test"},
                goal="Purchase",
                max_steps=5,
            )
            obs = await adapter.reset(task)
            assert obs.get("bridge") is True
            assert adapter._bridge_active is True

            obs2, reward, done, info = await adapter.step("search[widget]")
            assert obs2.get("bridge") is True
            assert reward == 1.0
            assert done is True
            assert info["action_type"] == "bridge"

            # Evaluate should report success since reward >= 1.0.
            assert await adapter.evaluate(task, ["search[widget]"]) is True

    @pytest.mark.asyncio
    async def test_smart_mock_fallback_when_import_fails(self) -> None:
        """When elizaos_webshop import fails, smart-mock runtime is used."""
        # Force the import to fail by removing any cached entries and
        # injecting a stub package that raises on submodule import.
        broken_pkg = types.ModuleType("elizaos_webshop")

        class _RaisingLoader:
            def find_module(self, fullname, path=None):  # noqa: D401
                if fullname.startswith("elizaos_webshop"):
                    return self
                return None

            def load_module(self, fullname):  # noqa: D401
                raise ImportError(f"forced failure for {fullname}")

        # Easier: patch the bridge loader directly.
        with patch.object(
            ws_mod,
            "_load_elizaos_webshop_bridge",
            return_value=(None, None),
        ):
            adapter = ws_mod.WebShopEnvironmentAdapter()
            await adapter.initialize()
            assert adapter._bridge_env is None

            # Smart-mock path still works with injected products.
            task = AgentBenchTask(
                id="ws-mock-0000",
                environment=AgentBenchEnvironment.WEB_SHOPPING,
                description="Buy headphones",
                initial_state={
                    "budget": 100,
                    "products": [
                        {
                            "id": "P001",
                            "name": "Wireless Bluetooth Headphones",
                            "price": 79.99,
                            "category": "Electronics",
                            "rating": 4.5,
                            "features": ["noise cancelling"],
                            "options": {"color": ["black"]},
                        }
                    ],
                },
                goal="Buy",
                max_steps=10,
            )
            await adapter.reset(task)
            obs, _, _, _ = await adapter.step("search[headphones]")
            assert obs["page"] == "search_results"
            assert len(obs["results"]) > 0
            assert adapter._bridge_active is False


# ---------------------------------------------------------------------------
# Householding / ALFWorld auto-fetch
# ---------------------------------------------------------------------------


class TestAlfworldAutoFetch:
    def test_no_autofetch_when_opt_out(self, tmp_path, monkeypatch) -> None:
        """AGENTBENCH_NO_AUTOFETCH=1 short-circuits the download."""
        monkeypatch.setenv("AGENTBENCH_NO_AUTOFETCH", "1")
        monkeypatch.setenv("ALFWORLD_DATA", str(tmp_path / "alfworld"))

        # Pretend alfworld is importable but data is missing.
        fake_pkg = types.ModuleType("alfworld")
        with patch.dict(sys.modules, {"alfworld": fake_pkg}):
            with patch("subprocess.run") as mock_run:
                available, reason = hh_mod.ensure_alfworld_data()

        assert available is False
        assert "AGENTBENCH_NO_AUTOFETCH" in (reason or "")
        mock_run.assert_not_called()

    def test_skips_when_alfworld_not_installed(self, tmp_path, monkeypatch) -> None:
        """No subprocess call when the alfworld package is missing."""
        monkeypatch.delenv("AGENTBENCH_NO_AUTOFETCH", raising=False)
        monkeypatch.setenv("ALFWORLD_DATA", str(tmp_path / "alfworld"))

        # Make sure alfworld is NOT importable.
        with patch.dict(sys.modules, {"alfworld": None}):
            with patch("subprocess.run") as mock_run:
                available, reason = hh_mod.ensure_alfworld_data()

        assert available is False
        assert "alfworld package not installed" in (reason or "")
        mock_run.assert_not_called()

    def test_invokes_alfworld_download_when_data_missing(
        self, tmp_path, monkeypatch
    ) -> None:
        """When alfworld is installed but data missing, run alfworld-download."""
        monkeypatch.delenv("AGENTBENCH_NO_AUTOFETCH", raising=False)
        data_dir = tmp_path / "alfworld"
        monkeypatch.setenv("ALFWORLD_DATA", str(data_dir))

        fake_pkg = types.ModuleType("alfworld")
        # Pretend alfworld-download CLI is on PATH so the subprocess call
        # uses the entry-point form.
        with patch.dict(sys.modules, {"alfworld": fake_pkg}), \
                patch("shutil.which", return_value="/usr/local/bin/alfworld-download"):
            # subprocess.run pretends to succeed; populate the data dir
            # via a side effect so the post-condition check passes.
            def fake_run(cmd, env=None, check=False, capture_output=False, text=False, timeout=None):  # noqa: ARG001
                (data_dir / "json_2.1.1").mkdir(parents=True, exist_ok=True)
                (data_dir / "json_2.1.1" / "marker").write_text("ok", encoding="utf-8")
                result = MagicMock()
                result.returncode = 0
                result.stdout = "downloaded"
                result.stderr = ""
                return result

            with patch("subprocess.run", side_effect=fake_run) as mock_run:
                available, reason = hh_mod.ensure_alfworld_data()

            assert available is True, reason
            mock_run.assert_called_once()
            # Subsequent calls hit the module-level cache and don't rerun.
            mock_run.reset_mock()
            available2, _ = hh_mod.ensure_alfworld_data()
            assert available2 is True
            mock_run.assert_not_called()

    def test_default_data_dir_is_set_when_unset(
        self, tmp_path, monkeypatch
    ) -> None:
        """When ALFWORLD_DATA is unset, default to ``~/.cache/elizaos/alfworld``."""
        monkeypatch.delenv("AGENTBENCH_NO_AUTOFETCH", raising=False)
        monkeypatch.delenv("ALFWORLD_DATA", raising=False)

        fake_pkg = types.ModuleType("alfworld")
        # Force the "populated" check to pass without any actual download.
        with patch.dict(sys.modules, {"alfworld": fake_pkg}), \
                patch.object(hh_mod, "_alfworld_data_is_populated", return_value=True), \
                patch("subprocess.run") as mock_run:
            available, _ = hh_mod.ensure_alfworld_data()

        assert available is True
        assert "ALFWORLD_DATA" in __import__("os").environ
        # Default path was assigned to the env var.
        assert "alfworld" in __import__("os").environ["ALFWORLD_DATA"]
        mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# KG SPARQL auto-spawn
# ---------------------------------------------------------------------------


class TestKnowledgeGraphAutoSpawn:
    def test_no_autostart_by_default(self, monkeypatch) -> None:
        """Without AGENTBENCH_KG_SPARQL_AUTOSTART, the docker call is skipped."""
        monkeypatch.delenv("AGENTBENCH_KG_SPARQL_AUTOSTART", raising=False)
        monkeypatch.delenv("AGENTBENCH_KG_SPARQL_URL", raising=False)

        with patch("subprocess.run") as mock_run:
            endpoint = kg_mod._try_start_virtuoso()

        assert endpoint is None
        mock_run.assert_not_called()

    def test_explicit_url_is_honored(self, monkeypatch) -> None:
        """If the user already runs Virtuoso, AGENTBENCH_KG_SPARQL_URL wins."""
        monkeypatch.setenv("AGENTBENCH_KG_SPARQL_URL", "http://kg.example:8890/sparql")
        with patch("subprocess.run") as mock_run:
            endpoint = kg_mod._try_start_virtuoso()
        assert endpoint == "http://kg.example:8890/sparql"
        mock_run.assert_not_called()

    def test_spawns_container_when_autostart_and_docker_available(
        self, monkeypatch
    ) -> None:
        monkeypatch.setenv("AGENTBENCH_KG_SPARQL_AUTOSTART", "1")
        monkeypatch.delenv("AGENTBENCH_KG_SPARQL_URL", raising=False)

        def fake_run(cmd, check=False, capture_output=False, text=False, timeout=None):  # noqa: ARG001
            result = MagicMock()
            result.returncode = 0
            result.stdout = "deadbeef"
            result.stderr = ""
            return result

        with patch("shutil.which", return_value="/usr/bin/docker"), \
                patch("subprocess.run", side_effect=fake_run) as mock_run:
            endpoint = kg_mod._try_start_virtuoso()

        assert endpoint == "http://localhost:8890/sparql"
        mock_run.assert_called_once()
        # Verify the command starts with ``docker run``.
        args, _ = mock_run.call_args
        cmd = args[0]
        assert cmd[0] == "docker" and cmd[1] == "run"

    def test_falls_back_when_docker_unavailable(self, monkeypatch) -> None:
        monkeypatch.setenv("AGENTBENCH_KG_SPARQL_AUTOSTART", "1")
        monkeypatch.delenv("AGENTBENCH_KG_SPARQL_URL", raising=False)

        with patch("shutil.which", return_value=None), \
                patch("subprocess.run") as mock_run:
            endpoint = kg_mod._try_start_virtuoso()

        assert endpoint is None
        mock_run.assert_not_called()
