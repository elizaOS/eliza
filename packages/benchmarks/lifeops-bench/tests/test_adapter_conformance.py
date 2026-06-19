"""Cross-adapter conformance test (Wave 3A).

The conformance invariant — PerfectAgent scores 1.0, WrongAgent scores
0.0 — was proven for the in-process executor in Wave 2H. This file
extends the same invariant across all three adapter backends:

- :func:`build_hermes_agent`           (Hermes XML <tool_call> wire format)
- :func:`build_cerebras_direct_agent`  (native OpenAI tool_calls)
- :func:`build_eliza_agent`            (HTTP bench server bridge)

We can't hit live LLM endpoints in CI, so each adapter is wired against
a deterministic mock that emits exactly what PerfectAgent would emit
(via the scenario's ``ground_truth_actions``). This proves the adapter
PLUMBING — turn threading, tool-call serialization, tool-result
threading — is correct independent of model behavior. Real-LLM
evaluation lives in :mod:`tests.test_live_scenarios` (live-gated).

Sampling: at most 5 STATIC scenarios per domain, sorted by id, drawn
from the registry where every ground-truth action name is in
``supported_actions()``. The inline conformance fixtures in
``tests/test_conformance.py`` are not needed here — those exercise the
executor directly; the adapter test exercises the wire path.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
import pytest

from eliza_lifeops_bench.agents._openai_compat import OpenAICompatAgent
from eliza_lifeops_bench.clients.cerebras import CerebrasClient
from eliza_lifeops_bench.clients.hermes import HermesClient
from eliza_lifeops_bench.lifeworld.snapshots import (
    SNAPSHOT_SPECS,
    build_world_for,
)
from eliza_lifeops_bench.runner import LifeOpsBenchRunner, supported_actions
from eliza_lifeops_bench.scenarios import ALL_SCENARIOS
from eliza_lifeops_bench.types import (
    Domain,
    MessageTurn,
    Scenario,
    ScenarioMode,
)


# ---------------------------------------------------------------------------
# Sampling: ≤5 STATIC scenarios per domain, sorted deterministically by id.
# ---------------------------------------------------------------------------


_MAX_PER_DOMAIN = 5


def _sample_scenarios() -> list[Scenario]:
    """Return up to 5 STATIC scenarios per Domain whose gt actions are all supported.

    Sorted by ``Domain.value`` then by scenario id so the sample is
    stable across runs and pytest IDs are reproducible.
    """
    sup = supported_actions()
    by_domain: dict[Domain, list[Scenario]] = {}
    for s in ALL_SCENARIOS:
        if s.mode is not ScenarioMode.STATIC:
            continue
        gt_names = {a.name for a in s.ground_truth_actions}
        if not gt_names.issubset(sup):
            continue
        by_domain.setdefault(s.domain, []).append(s)

    sampled: list[Scenario] = []
    for domain in sorted(by_domain.keys(), key=lambda d: d.value):
        for s in sorted(by_domain[domain], key=lambda x: x.id)[:_MAX_PER_DOMAIN]:
            sampled.append(s)
    return sampled


SAMPLED_SCENARIOS: list[Scenario] = _sample_scenarios()


def _world_factory_for(scenario: Scenario) -> Callable[[int, str], Any]:
    """Match the conformance test's per-scenario world factory.

    Wave 2A scenarios reference the medium snapshot (seed=2026); the
    tiny snapshot is seed=42. Anything else would be inline conformance
    fixtures, but the adapter sampler only includes registry scenarios so
    those two seeds cover all sampled scenarios.
    """
    spec_name = "medium_seed_2026" if scenario.world_seed == 2026 else "tiny_seed_42"
    spec = next(s for s in SNAPSHOT_SPECS if s.name == spec_name)

    def _factory(_seed: int, _now_iso: str):
        return build_world_for(spec)

    return _factory


# ---------------------------------------------------------------------------
# Mock state — shared across adapter mocks. Each scenario run gets a fresh
# instance with a cursor over `scenario.ground_truth_actions`. PerfectAgent
# variant returns the next gt action; WrongAgent variant always returns
# CONTACTS.delete on a bogus id (the same shape as
# eliza_lifeops_bench.agents.WrongAgent in "wrong_action" mode).
# ---------------------------------------------------------------------------


_WRONG_ACTION_NAME = "CONTACTS.delete"
_WRONG_ACTION_KWARGS: dict[str, Any] = {
    "id": "definitely_not_a_real_contact_id"
}


class _MockScript:
    """Deterministic cursor over a scenario's ground-truth actions.

    ``perfect`` mode emits each gt action in order, then a final
    terminating prose response whose body contains every required output
    substring (so the substring rubric also passes). ``wrong`` mode
    emits ``CONTACTS.delete`` against a bogus id every turn — the
    runner will hit max_turns and the rubric will mark the scenario as
    a 0.
    """

    def __init__(self, scenario: Scenario, *, mode: str) -> None:
        if mode not in {"perfect", "wrong"}:
            raise ValueError(f"unknown mock mode: {mode!r}")
        self.scenario = scenario
        self.mode = mode
        self._cursor = 0
        self._call_index = 0

    def next_response(self) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
        """Return ``(prose, [(tool_name, tool_kwargs), ...])`` for the next turn."""
        self._call_index += 1
        if self.mode == "wrong":
            return ("", [(_WRONG_ACTION_NAME, dict(_WRONG_ACTION_KWARGS))])

        # perfect mode
        if self._cursor < len(self.scenario.ground_truth_actions):
            action = self.scenario.ground_truth_actions[self._cursor]
            self._cursor += 1
            return ("", [(action.name, dict(action.kwargs))])

        # Script exhausted — emit a terminal RESPOND turn whose content
        # contains every required substring so the substring rubric passes.
        # Mirrors PerfectAgent's terminator.
        required = self.scenario.required_outputs or []
        body = "Done. " + " ".join(required) + "." if required else "Done."
        return (body, [])


# ---------------------------------------------------------------------------
# Hermes adapter mock — httpx.MockTransport + <tool_call> XML wire format
# ---------------------------------------------------------------------------


def _hermes_response_payload(prose: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-conformance",
        "model": "NousResearch/Hermes-3-Llama-3.1-70B",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": prose},
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 10,
            "total_tokens": 20,
        },
    }


def _render_hermes_response(prose: str, calls: list[tuple[str, dict[str, Any]]]) -> str:
    """Render the script's (prose, calls) tuple as Hermes-format text."""
    blocks: list[str] = []
    if prose:
        blocks.append(prose)
    for name, args in calls:
        payload = json.dumps({"name": name, "arguments": args}, separators=(",", ":"))
        blocks.append(f"<tool_call>{payload}</tool_call>")
    return "\n".join(blocks) if blocks else "Done."


def _build_hermes_mock_agent(script: _MockScript) -> tuple[OpenAICompatAgent, httpx.AsyncClient]:
    """Wire an OpenAICompatAgent against a mocked HermesClient."""

    def handler(request: httpx.Request) -> httpx.Response:
        prose, calls = script.next_response()
        text = _render_hermes_response(prose, calls)
        return httpx.Response(200, json=_hermes_response_payload(text))

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)

    def factory() -> HermesClient:
        return HermesClient(
            base_url="https://hermes.example.com/v1",
            api_key="sk-conformance",
            model="NousResearch/Hermes-3-Llama-3.1-70B",
            http_client=http_client,
        )

    agent = OpenAICompatAgent(factory)
    return agent, http_client


# ---------------------------------------------------------------------------
# Cerebras adapter mock — httpx.MockTransport + native OpenAI tool_calls
# ---------------------------------------------------------------------------


def _cerebras_response_payload(
    prose: str, calls: list[tuple[str, dict[str, Any]]]
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": prose or None}
    finish_reason = "stop"
    if calls:
        message["tool_calls"] = [
            {
                "id": f"call_conf_{i}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args, sort_keys=True),
                },
            }
            for i, (name, args) in enumerate(calls)
        ]
        finish_reason = "tool_calls"
    return {
        "id": "chatcmpl-conformance",
        "model": "gpt-oss-120b",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 10,
            "total_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


def _build_cerebras_mock_agent(
    script: _MockScript,
) -> tuple[OpenAICompatAgent, httpx.AsyncClient]:
    """Wire an OpenAICompatAgent against a mocked CerebrasClient."""

    def handler(request: httpx.Request) -> httpx.Response:
        prose, calls = script.next_response()
        return httpx.Response(200, json=_cerebras_response_payload(prose, calls))

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)

    def factory() -> CerebrasClient:
        return CerebrasClient(
            api_key="sk-conformance",
            model="gpt-oss-120b",
            http_client=http_client,
        )

    return OpenAICompatAgent(factory), http_client


# ---------------------------------------------------------------------------
# Eliza adapter mock — bypass HTTP, hand-build a fake ElizaClient
# ---------------------------------------------------------------------------


def _ensure_eliza_adapter_importable() -> None:
    """Inject the sibling eliza-adapter source path so tests can import it
    even when the package isn't pip-installed in the active env."""
    try:
        import eliza_adapter  # noqa: F401
        return
    except ImportError:
        pass
    candidate = Path(__file__).resolve().parents[2] / "eliza-adapter"
    if (candidate / "eliza_adapter").is_dir():
        sys.path.insert(0, str(candidate))


_ensure_eliza_adapter_importable()


class _FakeElizaClient:
    """Stand-in for ``eliza_adapter.client.ElizaClient`` that never touches HTTP.

    Implements only the methods ``build_lifeops_bench_agent_fn`` calls:
    ``wait_until_ready``, ``reset``, and ``lifeops_message``. Each test
    instance is created with a SINGLE scenario script; every reset (no
    matter the task_id) routes to the same script so the adapter's
    quirky per-turn ``id(conversation_history)`` keying — which makes
    it call ``reset`` more than once for one logical scenario — does
    not break the mock. (The adapter copies history with ``list(...)``
    each turn, so its ``task_ids_by_conversation[id(history)]`` cache
    misses every turn and re-issues reset.)
    """

    def __init__(self, script: _MockScript) -> None:
        self._script = script
        # Sentinel matching the field on ElizaClient so the agent can pull
        # base_url for logging without crashing.
        self.base_url = "http://fake-eliza.test"

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        return None

    def reset(
        self,
        task_id: str,
        benchmark: str,
        *,
        world_snapshot_path: str | None = None,
        now_iso: str | None = None,
    ) -> dict[str, object]:
        return {"ok": True, "task_id": task_id}

    def lifeops_message(
        self,
        task_id: str,
        text: str,
        *,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        prose, calls = self._script.next_response()
        # Match the bench server's response shape (see
        # eliza_adapter.lifeops_bench): { text, tool_calls, usage }.
        tool_calls: list[dict[str, object]] = []
        for i, (name, args) in enumerate(calls):
            tool_calls.append(
                {
                    "id": f"call_conf_{i}",
                    "name": name,
                    "arguments": args,
                    "ok": True,
                }
            )
        return {
            "text": prose,
            "tool_calls": tool_calls,
            "usage": {"promptTokens": 10, "completionTokens": 10},
        }


def _build_eliza_mock_agent(
    script: _MockScript,
) -> Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]:
    """Wire build_lifeops_bench_agent_fn against the FakeElizaClient.

    A fresh fake client is created per scenario so cleanup is automatic.
    """
    from eliza_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    fake = _FakeElizaClient(script)
    snapshot_path = "/dev/null"  # never read — fake_client.reset ignores it
    return build_lifeops_bench_agent_fn(
        client=fake,
        world_snapshot_path=snapshot_path,
    )


# ---------------------------------------------------------------------------
# Driver: build runner, run a scenario, return the score.
# ---------------------------------------------------------------------------


async def _drive_scenario(
    scenario: Scenario,
    agent_fn: Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]],
) -> float:
    runner = LifeOpsBenchRunner(
        agent_fn=agent_fn,
        world_factory=_world_factory_for(scenario),
        scenarios=[scenario],
        concurrency=1,
        seeds=1,
        max_cost_usd=1000.0,
        per_scenario_timeout_s=30,
    )
    result = await runner.run_one(scenario, scenario.world_seed)
    return result.total_score


# ---------------------------------------------------------------------------
# Tests — Hermes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_hermes_adapter_perfect_mock_scores_one(scenario: Scenario) -> None:
    """Hermes adapter + PerfectAgent-style mock must score 1.0."""
    script = _MockScript(scenario, mode="perfect")
    agent, http_client = _build_hermes_mock_agent(script)
    try:
        score = await _drive_scenario(scenario, agent)
    finally:
        await http_client.aclose()
    assert score == pytest.approx(1.0, abs=1e-6), (
        f"Hermes adapter scored {score:.4f} on {scenario.id} with PerfectAgent mock"
    )


@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_hermes_adapter_wrong_mock_scores_zero(scenario: Scenario) -> None:
    """Hermes adapter + WrongAgent-style mock must score 0.0."""
    script = _MockScript(scenario, mode="wrong")
    agent, http_client = _build_hermes_mock_agent(script)
    try:
        score = await _drive_scenario(scenario, agent)
    finally:
        await http_client.aclose()
    assert score == pytest.approx(0.0, abs=1e-6), (
        f"Hermes adapter scored {score:.4f} on {scenario.id} with WrongAgent mock"
    )


# ---------------------------------------------------------------------------
# Tests — Cerebras-direct
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_cerebras_direct_adapter_perfect_mock_scores_one(
    scenario: Scenario,
) -> None:
    """Cerebras-direct adapter + PerfectAgent-style mock must score 1.0."""
    script = _MockScript(scenario, mode="perfect")
    agent, http_client = _build_cerebras_mock_agent(script)
    try:
        score = await _drive_scenario(scenario, agent)
    finally:
        await http_client.aclose()
    assert score == pytest.approx(1.0, abs=1e-6), (
        f"Cerebras adapter scored {score:.4f} on {scenario.id} with PerfectAgent mock"
    )


@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_cerebras_direct_adapter_wrong_mock_scores_zero(
    scenario: Scenario,
) -> None:
    """Cerebras-direct adapter + WrongAgent-style mock must score 0.0."""
    script = _MockScript(scenario, mode="wrong")
    agent, http_client = _build_cerebras_mock_agent(script)
    try:
        score = await _drive_scenario(scenario, agent)
    finally:
        await http_client.aclose()
    assert score == pytest.approx(0.0, abs=1e-6), (
        f"Cerebras adapter scored {score:.4f} on {scenario.id} with WrongAgent mock"
    )


# ---------------------------------------------------------------------------
# Tests — Eliza adapter (HTTP bench server bypassed via FakeElizaClient)
# ---------------------------------------------------------------------------


def _eliza_adapter_available() -> bool:
    try:
        import eliza_adapter.lifeops_bench  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.skipif(
    not _eliza_adapter_available(),
    reason="eliza_adapter not importable; install packages/benchmarks/eliza-adapter to run",
)
@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_eliza_adapter_perfect_mock_scores_one(scenario: Scenario) -> None:
    """Eliza adapter + PerfectAgent-style mock must score 1.0."""
    script = _MockScript(scenario, mode="perfect")
    agent_fn = _build_eliza_mock_agent(script)
    score = await _drive_scenario(scenario, agent_fn)
    assert score == pytest.approx(1.0, abs=1e-6), (
        f"Eliza adapter scored {score:.4f} on {scenario.id} with PerfectAgent mock"
    )


@pytest.mark.skipif(
    not _eliza_adapter_available(),
    reason="eliza_adapter not importable; install packages/benchmarks/eliza-adapter to run",
)
@pytest.mark.parametrize(
    "scenario", SAMPLED_SCENARIOS, ids=lambda s: s.id,
)
async def test_eliza_adapter_wrong_mock_scores_zero(scenario: Scenario) -> None:
    """Eliza adapter + WrongAgent-style mock must score 0.0."""
    script = _MockScript(scenario, mode="wrong")
    agent_fn = _build_eliza_mock_agent(script)
    score = await _drive_scenario(scenario, agent_fn)
    assert score == pytest.approx(0.0, abs=1e-6), (
        f"Eliza adapter scored {score:.4f} on {scenario.id} with WrongAgent mock"
    )


# ---------------------------------------------------------------------------
# Sanity check: the sampler picked at least one scenario per supported domain
# ---------------------------------------------------------------------------


def test_adapter_conformance_sampling_covers_every_domain(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Print + assert the per-domain sample distribution.

    Confirms the sampler isn't silently skipping a whole domain (which
    would mean adapter conformance for that domain is untested).
    """
    by_domain: dict[str, int] = {}
    for s in SAMPLED_SCENARIOS:
        by_domain[s.domain.value] = by_domain.get(s.domain.value, 0) + 1
    print("\nLifeOpsBench adapter conformance sampling")
    print(f"  total scenarios sampled: {len(SAMPLED_SCENARIOS)}")
    for domain, n in sorted(by_domain.items()):
        print(f"    {domain:<12} {n} scenarios")

    captured = capsys.readouterr()
    assert "scenarios sampled" in captured.out
    assert len(SAMPLED_SCENARIOS) > 0, "sampler returned no scenarios"
    for n in by_domain.values():
        assert n <= _MAX_PER_DOMAIN
