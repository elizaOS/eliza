from __future__ import annotations

import os

import pytest

from elizaos.agent_orchestrator_env import eliza_agent_orchestrator_load_requested


@pytest.fixture(autouse=True)
def clear_orch_env() -> object:
    old = os.environ.pop("ELIZA_AGENT_ORCHESTRATOR", None)
    yield
    if old is None:
        os.environ.pop("ELIZA_AGENT_ORCHESTRATOR", None)
    else:
        os.environ["ELIZA_AGENT_ORCHESTRATOR"] = old


def test_eliza_agent_orchestrator_default_off() -> None:
    assert eliza_agent_orchestrator_load_requested() is False


def test_eliza_agent_orchestrator_explicit_on() -> None:
    os.environ["ELIZA_AGENT_ORCHESTRATOR"] = "1"
    assert eliza_agent_orchestrator_load_requested() is True


def test_eliza_agent_orchestrator_explicit_off() -> None:
    os.environ["ELIZA_AGENT_ORCHESTRATOR"] = "0"
    assert eliza_agent_orchestrator_load_requested() is False
