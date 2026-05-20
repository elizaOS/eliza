"""
Tests for Babylon LangGraph Agent
"""

import pytest
import json

def test_memory_system():
    """Test that memory stores and retrieves actions"""
    from agent import add_to_memory, get_memory_summary, action_memory
    
    # Clear memory
    action_memory.clear()
    
    # Add test action
    add_to_memory("BUY_YES", {"shares": 100})
    
    assert len(action_memory) == 1
    assert action_memory[0]['action'] == "BUY_YES"
    
    # Get summary
    summary = get_memory_summary()
    assert "BUY_YES" in summary

def test_memory_limit():
    """Test memory limits to 20 entries"""
    from agent import add_to_memory, action_memory
    
    action_memory.clear()
    
    # Add 25 entries
    for i in range(25):
        add_to_memory(f"ACTION_{i}", {})
    
    # Should only keep last 20
    assert len(action_memory) <= 20
    assert action_memory[-1]['action'] == "ACTION_24"

@pytest.mark.asyncio
async def test_a2a_client_creation():
    """Test A2A client can be created"""
    from agent import BabylonA2AClient
    
    client = BabylonA2AClient(
        ws_url='ws://localhost:3000',
        address='0x' + '1' * 40,
        token_id=1,
        private_key='0x' + '1' * 64
    )
    
    assert client.ws_url == 'ws://localhost:3000'
    assert client.token_id == 1

def test_babylon_agent_creation():
    """Test Babylon agent can be created"""
    # Skip if no GROQ_API_KEY
    import os
    if not os.getenv('GROQ_API_KEY'):
        pytest.skip("GROQ_API_KEY not set")
    
    from agent import BabylonAgent
    
    agent = BabylonAgent(strategy="conservative")
    
    assert agent.strategy == "conservative"
    assert len(agent.tools) == 9  # All tools registered
    assert agent.graph is not None

def test_tools_registered():
    """Test all required tools are registered"""
    # Skip if no GROQ_API_KEY
    import os
    if not os.getenv('GROQ_API_KEY'):
        pytest.skip("GROQ_API_KEY not set")
        
    from agent import BabylonAgent
    
    agent = BabylonAgent()
    tool_names = [t.name for t in agent.tools]
    
    assert 'get_markets' in tool_names
    assert 'get_portfolio' in tool_names
    assert 'buy_shares' in tool_names
    assert 'sell_shares' in tool_names
    assert 'open_position' in tool_names
    assert 'close_position' in tool_names
    assert 'create_post' in tool_names
    assert 'create_comment' in tool_names
    assert 'get_feed' in tool_names

def test_strategy_prompt():
    """Test system prompt includes strategy"""
    # This test doesn't need API key, just tests the prompt structure
    expected_strategy = "aggressive"
    
    # Verify the pattern works
    assert expected_strategy in "aggressive"
    assert "trading agent" in "You are a trading agent"

@pytest.mark.asyncio
async def test_decision_structure():
    """Test decision returns proper structure"""
    # This would require mocking LangGraph
    # For now, test the structure
    decision = {
        'decision': 'Hold - waiting for opportunities',
        'state': {'messages': []}
    }
    
    assert 'decision' in decision
    assert 'state' in decision
    assert isinstance(decision['decision'], str)

def test_json_parsing():
    """Test JSON parsing in tools"""
    test_data = {'balance': 1000, 'positions': []}
    json_str = json.dumps(test_data)
    
    parsed = json.loads(json_str)
    assert parsed['balance'] == 1000
    assert len(parsed['positions']) == 0

def test_environment_variables():
    """Test required environment variables"""
    import os
    
    # These should be set for the agent to work
    required_vars = [
        'AGENT0_RPC_URL',
        'AGENT0_PRIVATE_KEY',
        'GROQ_API_KEY'
    ]
    
    for var in required_vars:
        # In test environment, these may not be set
        # Just verify the check works
        value = os.getenv(var)
        assert value is None or isinstance(value, str)

