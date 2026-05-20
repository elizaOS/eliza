"""Tests for group chat, working memory, and token budget fields in EnvironmentStateSchema."""

from src.training.schemas import EnvironmentStateSchema


def test_environment_state_group_chat_fields():
    """Round-trip test: camelCase input -> parsed fields."""
    raw = {
        "agentBalance": 10500,
        "agentPnL": 500,
        "openPositions": 2,
        "groupChatsActive": 3,
        "groupChatFacts": ["BTC bullish sentiment", "ETH merger talk"],
        "groupChatIntelTokenEstimate": 400,
        "promptTokenEstimate": 4500,
        "contextBreakdown": {"system": 800, "groupChat": 400, "markets": 1200},
        "workingMemoryFactCount": 5,
        "workingMemoryActiveThesis": "BTC bullish",
    }
    schema = EnvironmentStateSchema.from_dict(raw)
    assert schema.group_chats_active == 3
    assert schema.group_chat_facts == ["BTC bullish sentiment", "ETH merger talk"]
    assert schema.group_chat_intel_token_estimate == 400
    assert schema.prompt_token_estimate == 4500
    assert schema.context_breakdown == {"system": 800, "groupChat": 400, "markets": 1200}
    assert schema.working_memory_fact_count == 5
    assert schema.working_memory_active_thesis == "BTC bullish"


def test_environment_state_defaults_when_missing():
    """Fields default to None when not present (backward compat)."""
    raw = {"agentBalance": 1000, "agentPnL": 0, "openPositions": 0}
    schema = EnvironmentStateSchema.from_dict(raw)
    assert schema.group_chats_active is None
    assert schema.group_chat_facts is None
    assert schema.prompt_token_estimate is None
    assert schema.context_breakdown is None
    assert schema.working_memory_fact_count is None
    assert schema.working_memory_active_thesis is None


def test_environment_state_snake_case_input():
    """Accepts snake_case field names too."""
    raw = {
        "agent_balance": 5000,
        "agent_pnl": 100,
        "open_positions": 1,
        "group_chats_active": 2,
        "group_chat_facts": ["fact1"],
        "working_memory_fact_count": 3,
    }
    schema = EnvironmentStateSchema.from_dict(raw)
    assert schema.group_chats_active == 2
    assert schema.group_chat_facts == ["fact1"]
    assert schema.working_memory_fact_count == 3
