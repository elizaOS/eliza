"""
End-to-end smoke tests for the paper-faithful tool surface.

These tests run a short heuristic-driven simulation and assert that the
paper-faithful tools (``SEND_EMAIL``, ``READ_EMAIL``, ``SEARCH_WEB``,
``NOTEPAD_WRITE``, ``DELEGATE_*``) are actually exercised — protecting against
regressions where the tool surface drifts back to the old structured-only
shape.

References:
- Vending-Bench paper: https://arxiv.org/abs/2502.15840
"""

from decimal import Decimal

import pytest

from elizaos_vending_bench import (
    ActionType,
    EmailSimulator,
    Notepad,
    VendingAgent,
    VendingEnvironment,
    WebSimulator,
)
from elizaos_vending_bench.sub_agents import EmailSubAgent, ResearchSubAgent


class TestEmailSimulator:
    """Unit tests for the EmailSimulator."""

    def test_send_email_to_known_supplier_generates_reply(self) -> None:
        env = VendingEnvironment(seed=42)
        msg, result = env.email_simulator.send_email(
            env.state,
            to="orders@beverage-dist.example",
            subject="Quote request",
            body="Please quote 50 units of water and 50 units of soda_cola.",
        )
        assert msg.direction == "out"
        assert "Beverage Distributors Inc" in result
        # A reply should be scheduled for the next sim-day.
        replies = [m for m in env.state.inbox if m.direction == "in"]
        assert len(replies) == 1
        reply = replies[0]
        assert reply.delivery_day == env.state.current_day + 1
        assert "water" in reply.body.lower()

    def test_send_email_to_unknown_supplier_bounces(self) -> None:
        env = VendingEnvironment(seed=42)
        _msg, result = env.email_simulator.send_email(
            env.state,
            to="ceo@hallucinated-supplier.example",
            subject="Hi",
            body="Hello?",
        )
        # The bounce notice is enqueued so the agent gets feedback.
        bounces = [m for m in env.state.inbox if m.metadata.get("bounce") == "true"]
        assert len(bounces) == 1
        assert "bounce" in result.lower() or "not a known supplier" in result.lower()

    def test_read_email_marks_messages_as_read(self) -> None:
        env = VendingEnvironment(seed=42)
        env.email_simulator.send_email(
            env.state,
            to="orders@snack-co.example",
            subject="Pricing",
            body="Quote 30 chips_regular and 20 cookies",
        )
        # Bump the day so the reply becomes visible.
        env.state.current_day += 1
        rendered = env.email_simulator.read_email(env.state)
        assert "SnackCo Wholesale" in rendered
        # All inbox messages are now read.
        assert all(m.read for m in env.state.inbox)


class TestWebSimulator:
    """Unit tests for the WebSimulator."""

    def test_search_is_deterministic(self) -> None:
        sim1 = WebSimulator(seed=42)
        sim2 = WebSimulator(seed=42)
        r1 = sim1.search("wholesale beverage suppliers")
        r2 = sim2.search("wholesale beverage suppliers")
        assert [r.title for r in r1] == [r.title for r in r2]

    def test_search_returns_supplier_results(self) -> None:
        sim = WebSimulator(seed=42)
        results = sim.search("wholesale vending supplier")
        titles = " ".join(r.title for r in results).lower()
        assert "supplier" in titles or "wholesale" in titles


class TestNotepad:
    """Unit tests for the Notepad scratchpad."""

    def test_write_appends_dated_entry(self) -> None:
        env = VendingEnvironment(seed=42)
        Notepad.write(env.state, "Note one")
        Notepad.write(env.state, "Note two")
        rendered = Notepad.read(env.state)
        assert "Note one" in rendered
        assert "Note two" in rendered
        assert "[day 1]" in rendered

    def test_empty_write_rejected(self) -> None:
        env = VendingEnvironment(seed=42)
        result = Notepad.write(env.state, "")
        assert "Error" in result


class TestSubAgents:
    """Unit tests for the sub-agent heuristic paths."""

    @pytest.mark.asyncio
    async def test_email_sub_agent_sends_quote_requests(self) -> None:
        env = VendingEnvironment(seed=42)
        agent = EmailSubAgent(env=env, llm=None)
        report = await agent.run("inquire about water and soda_cola")
        assert report.tool_calls.count("SEND_EMAIL") >= 1
        # Outbox should reflect the sent emails.
        assert len(env.state.outbox) >= 1

    @pytest.mark.asyncio
    async def test_research_sub_agent_runs_searches_and_writes_notes(self) -> None:
        env = VendingEnvironment(seed=42)
        agent = ResearchSubAgent(env=env, llm=None)
        report = await agent.run("find wholesale pricing norms")
        assert "SEARCH_WEB" in report.tool_calls
        assert "NOTEPAD_WRITE" in report.tool_calls
        assert len(env.state.web_search_log) >= 1
        assert len(env.state.notepad) >= 1


class TestEndToEndSmoke:
    """End-to-end smoke test: 5-day heuristic run exercises all paper tools."""

    @pytest.mark.asyncio
    async def test_5_day_run_exercises_paper_tools(self) -> None:
        env = VendingEnvironment(initial_cash=Decimal("500.00"), seed=42)
        agent = VendingAgent(environment=env)

        result = await agent.run_simulation(
            max_days=5,
            max_actions_per_day=15,
            run_id="smoke_paper_tools",
        )

        action_types = {a.action_type for a in result.actions}

        # Paper-faithful tools must be exercised at least once.
        assert ActionType.SEND_EMAIL in action_types, (
            f"Expected at least one SEND_EMAIL action; saw {action_types}"
        )
        assert ActionType.SEARCH_WEB in action_types, (
            f"Expected at least one SEARCH_WEB action; saw {action_types}"
        )
        assert ActionType.NOTEPAD_WRITE in action_types, (
            f"Expected at least one NOTEPAD_WRITE action; saw {action_types}"
        )

        # Result counters surface the paper-faithful tool usage.
        assert result.emails_sent >= 1
        assert result.web_searches >= 1
        assert result.notepad_writes >= 1

        # The inbox should contain at least one supplier reply by day 5.
        assert len(env.state.inbox) >= 1
        assert any(m.direction == "in" and m.read for m in env.state.inbox)

    @pytest.mark.asyncio
    async def test_send_email_then_read_reply_next_day(self) -> None:
        """End-to-end: SEND_EMAIL on day 1, READ_EMAIL on day 2 sees the reply."""
        env = VendingEnvironment(seed=42)
        agent = VendingAgent(environment=env)

        # Direct action calls — bypass the heuristic so we can script this.
        result1, ok1 = agent._execute_action(
            ActionType.SEND_EMAIL,
            {
                "to": "orders@beverage-dist.example",
                "subject": "Quote",
                "body": "Please quote 50 units of water.",
            },
        )
        assert ok1, result1

        # Read immediately — the reply is scheduled for tomorrow, so it should
        # not yet be visible.
        result2, _ = agent._execute_action(ActionType.READ_EMAIL, {})
        assert "Beverage" not in result2 or "Inbox is empty" in result2 or "day 2" not in result2

        # Advance a day.
        agent._execute_action(ActionType.ADVANCE_DAY, {})

        # Now the reply is visible.
        result3, _ = agent._execute_action(ActionType.READ_EMAIL, {})
        assert "Beverage Distributors Inc" in result3 or "water" in result3.lower()


class TestEmailSimulatorInjection:
    """Make sure EmailSimulator references aren't accidentally lost."""

    def test_env_has_simulator_instances(self) -> None:
        env = VendingEnvironment(seed=42)
        assert isinstance(env.email_simulator, EmailSimulator)
        assert isinstance(env.web_simulator, WebSimulator)
        assert isinstance(env.notepad, Notepad)
