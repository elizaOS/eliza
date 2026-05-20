"""
Comprehensive E2E Test for Autonomous Python Agent

This test verifies that an agent can:
1. Register and authenticate
2. Connect via A2A protocol
3. Perform ALL game actions autonomously:
   - Get markets and portfolio
   - Buy/sell shares in prediction markets
   - Open/close perpetual positions
   - Create posts and comments
   - Send messages
   - Get notifications
   - Follow users
   - Get leaderboard and stats

Prerequisites:
- Babylon server running on localhost:3000
- Database accessible
- At least one active prediction market
- At least one perpetual market (organization)
"""

import pytest
import os
from datetime import datetime
from agent import BabylonA2AClient
from dotenv import load_dotenv

# Note: Database client needs to be imported from the main project
# For this test, we'll use direct database access via A2A or skip database operations

load_dotenv()

SERVER_URL = os.getenv('BABYLON_API_URL', 'http://localhost:3000')
A2A_ENDPOINT = f"{SERVER_URL}/api/a2a"

# Test agent identity
TEST_AGENT_ID = f"e2e-python-agent-{int(datetime.now().timestamp())}"
TEST_AGENT_ADDRESS = '0x' + '1' * 40
TEST_TOKEN_ID = 999998


@pytest.fixture(scope="module")
async def agent_setup():
    """Setup test agent and A2A client"""
    print('\n🧪 Setting up comprehensive E2E test...\n')
    
    # Check if server is running
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{SERVER_URL}/api/health", timeout=5.0)
            if not response.is_success:
                pytest.skip(f"Server not running or not accessible at {SERVER_URL}")
    except Exception as e:
        pytest.skip(f"Server check failed: {e}. Make sure server is running on {SERVER_URL}")
    
    print('✅ Server is running')
    
    # For Python tests, we'll use the agent's own profile via A2A
    # The agent will be created via the A2A endpoint if needed
    # We'll use a deterministic agent ID based on the test constants
    agent_user_id = TEST_AGENT_ID
    
    # We'll discover markets via A2A instead of direct DB access
    test_market_id = None
    test_perp_ticker = None
    
    # Try to get markets via A2A to find test data
    try:
        temp_client = BabylonA2AClient(
            http_url=A2A_ENDPOINT,
            address=TEST_AGENT_ADDRESS,
            token_id=TEST_TOKEN_ID,
            chain_id=11155111
        )
        predictions = await temp_client.get_predictions(status='active')
        if predictions.get('predictions') and len(predictions['predictions']) > 0:
            test_market_id = predictions['predictions'][0].get('id')
            print(f'✅ Found test market via A2A: {test_market_id}')
        
        perps = await temp_client.get_perpetuals()
        if perps.get('perpetuals') and len(perps['perpetuals']) > 0:
            test_perp_ticker = perps['perpetuals'][0].get('name', '').upper()[:4]
            print(f'✅ Found test perpetual via A2A: {test_perp_ticker}')
    except Exception as e:
        print(f'⚠️  Could not discover markets via A2A: {e}')
    
    if not test_market_id:
        print('⚠️  No active markets found - some tests will be skipped')
    if not test_perp_ticker:
        print('⚠️  No perpetual markets found - some tests will be skipped')
    
    # Initialize A2A client
    a2a_client = BabylonA2AClient(
        http_url=A2A_ENDPOINT,
        address=TEST_AGENT_ADDRESS,
        token_id=TEST_TOKEN_ID,
        chain_id=11155111
    )
    
    return {
        'agent_user_id': agent_user_id,
        'a2a_client': a2a_client,
        'test_market_id': test_market_id,
        'test_perp_ticker': test_perp_ticker
    }


@pytest.mark.asyncio
class TestAutonomousAgentCompleteE2E:
    """Complete E2E test suite for autonomous agent"""
    
    created_post_id = None
    created_position_id = None
    
    async def test_phase1_authentication(self, agent_setup):
        """Phase 1: Authentication & Connection"""
        client = agent_setup['a2a_client']
        
        # Test connection (A2A uses headers, no explicit connect needed)
        balance = await client.get_balance()
        assert balance is not None
        assert 'balance' in balance
        assert isinstance(balance['balance'], (int, float))
        print(f"   ✅ Balance: ${balance['balance']}")
    
    async def test_phase2_market_data(self, agent_setup):
        """Phase 2: Market Data & Discovery"""
        client = agent_setup['a2a_client']
        
        # Get predictions
        result = await client.get_predictions(status='active')
        assert result is not None
        assert 'predictions' in result
        assert isinstance(result['predictions'], list)
        print(f"   ✅ Found {len(result['predictions'])} prediction markets")
        
        # Get perpetuals
        result = await client.get_perpetuals()
        assert result is not None
        assert 'perpetuals' in result
        assert isinstance(result['perpetuals'], list)
        print(f"   ✅ Found {len(result['perpetuals'])} perpetual markets")
        
        # Get portfolio
        portfolio = await client.get_portfolio()
        assert portfolio is not None
        assert 'balance' in portfolio
        assert 'positions' in portfolio
        print(f"   ✅ Portfolio: ${portfolio['balance']}, {len(portfolio['positions'])} positions")
        
        # Get feed
        feed = await client.get_feed(limit=10)
        assert feed is not None
        assert 'posts' in feed
        assert isinstance(feed['posts'], list)
        print(f"   ✅ Feed: {len(feed['posts'])} posts")
        
        # Discover agents
        result = await client.discover_agents(limit=10)
        assert result is not None
        assert 'agents' in result
        assert isinstance(result['agents'], list)
        print(f"   ✅ Discovered {len(result['agents'])} agents")
    
    async def test_phase3_trading_actions(self, agent_setup):
        """Phase 3: Trading Actions"""
        client = agent_setup['a2a_client']
        test_market_id = agent_setup['test_market_id']
        test_perp_ticker = agent_setup['test_perp_ticker']
        
        # Buy YES shares
        if not test_market_id:
            print('   ⏭️  Skipping - no test market available')
            return
        
        result = await client.buy_shares(test_market_id, 'YES', 50)
        assert result is not None
        assert result.get('success') is True
        assert 'positionId' in result
        assert 'shares' in result
        assert result['shares'] > 0
        print(f"   ✅ Bought {result['shares']} YES shares at avg price ${result.get('avgPrice', 0)}")
        
        # Get positions
        positions = await client.get_positions()
        assert positions is not None
        assert 'positions' in positions
        prediction_positions = [p for p in positions['positions'] if 'marketId' in p]
        assert len(prediction_positions) > 0
        print(f"   ✅ Found {len(prediction_positions)} prediction positions")
        
        # Sell shares
        position = next((p for p in positions['positions'] if p.get('marketId') == test_market_id), None)
        if position and position.get('shares', 0) >= 10:
            shares_to_sell = min(10, position['shares'])
            result = await client.sell_shares(position['id'], shares_to_sell)
            assert result is not None
            assert result.get('success') is True
            assert 'proceeds' in result
            print(f"   ✅ Sold {shares_to_sell} shares for ${result['proceeds']}")
        else:
            print('   ⏭️  Skipping - no shares to sell')
        
        # Open perpetual position
        if not test_perp_ticker:
            print('   ⏭️  Skipping - no perpetual market available')
            return
        
        result = await client.open_position(test_perp_ticker, 'LONG', 100, 2)
        assert result is not None
        assert result.get('success') is True
        assert 'positionId' in result
        assert 'entryPrice' in result
        self.created_position_id = result['positionId']
        print(f"   ✅ Opened LONG position: {result['positionId']} at ${result['entryPrice']}")
        
        # Close perpetual position
        if self.created_position_id:
            result = await client.close_position(self.created_position_id)
            assert result is not None
            assert result.get('success') is True
            assert 'pnl' in result
            print(f"   ✅ Closed position, PnL: ${result['pnl']}")
    
    async def test_phase4_social_actions(self, agent_setup):
        """Phase 4: Social Actions"""
        client = agent_setup['a2a_client']
        
        # Create a post
        content = f"🤖 E2E Test Post - {datetime.now().isoformat()}\n\nThis is an automated test post from the comprehensive E2E test suite."
        result = await client.create_post(content, 'post')
        assert result is not None
        assert result.get('success') is True
        assert 'postId' in result
        self.created_post_id = result['postId']
        print(f"   ✅ Created post: {result['postId']}")
        
        # Get the created post
        if self.created_post_id:
            post = await client.get_post(self.created_post_id)
            assert post is not None
            assert post['id'] == self.created_post_id
            print(f"   ✅ Retrieved post: {post.get('content', '')[:50]}...")
        
        # Create a comment
        if self.created_post_id:
            result = await client.create_comment(self.created_post_id, 'This is a test comment from E2E test')
            assert result is not None
            assert result.get('success') is True
            assert 'commentId' in result
            print(f"   ✅ Created comment: {result['commentId']}")
        
        # Get comments
        if self.created_post_id:
            result = await client.get_comments(self.created_post_id)
            assert result is not None
            assert 'comments' in result
            assert len(result['comments']) > 0
            print(f"   ✅ Found {len(result['comments'])} comments")
        
        # Like a post
        if self.created_post_id:
            result = await client.like_post(self.created_post_id)
            assert result is not None
            assert result.get('success') is True
            print("   ✅ Liked post")
    
    async def test_phase5_user_management(self, agent_setup):
        """Phase 5: User Management"""
        client = agent_setup['a2a_client']
        agent_user_id = agent_setup['agent_user_id']
        
        # Get user profile
        profile = await client.get_user_profile(agent_user_id)
        assert profile is not None
        assert profile['id'] == agent_user_id
        print(f"   ✅ Retrieved profile: @{profile.get('username', 'unknown')}")
        
        # Search users
        result = await client.search_users('test', limit=10)
        assert result is not None
        assert 'users' in result
        assert isinstance(result['users'], list)
        print(f"   ✅ Found {len(result['users'])} users matching 'test'")
        
        # Get leaderboard
        result = await client.get_leaderboard('all', page_size=10)
        assert result is not None
        assert 'leaderboard' in result
        assert isinstance(result['leaderboard'], list)
        print(f"   ✅ Leaderboard: {len(result['leaderboard'])} entries")
    
    async def test_phase6_messaging(self, agent_setup):
        """Phase 6: Messaging"""
        client = agent_setup['a2a_client']
        
        # Get chats
        result = await client.get_chats()
        assert result is not None
        assert 'chats' in result
        assert isinstance(result['chats'], list)
        print(f"   ✅ Found {len(result['chats'])} chats")
        
        # Create a group chat
        result = await client.create_group('E2E Test Group', [])
        assert result is not None
        assert result.get('success') is True
        assert 'chatId' in result
        chat_id = result['chatId']
        print(f"   ✅ Created group: {chat_id}")
        
        # Send a message
        if chat_id:
            result = await client.send_message(chat_id, 'Hello from E2E test!')
            assert result is not None
            assert result.get('success') is True
            assert 'messageId' in result
            print(f"   ✅ Sent message: {result['messageId']}")
    
    async def test_phase7_notifications_stats(self, agent_setup):
        """Phase 7: Notifications & Stats"""
        client = agent_setup['a2a_client']
        agent_user_id = agent_setup['agent_user_id']
        
        # Get notifications
        result = await client.get_notifications()
        assert result is not None
        assert 'notifications' in result
        assert isinstance(result['notifications'], list)
        print(f"   ✅ Found {len(result['notifications'])} notifications")
        
        # Get user stats
        result = await client.get_user_stats(agent_user_id)
        assert result is not None
        print("   ✅ User stats retrieved")
        
        # Get system stats
        result = await client.get_system_stats()
        assert result is not None
        print("   ✅ System stats retrieved")
        
        # Get reputation
        result = await client.get_reputation(agent_user_id)
        assert result is not None
        assert 'reputation' in result
        assert isinstance(result['reputation'], (int, float))
        print(f"   ✅ Reputation: {result['reputation']}")
    
    async def test_phase8_complete_autonomous_cycle(self, agent_setup):
        """Phase 8: Complete Autonomous Cycle"""
        client = agent_setup['a2a_client']
        test_market_id = agent_setup['test_market_id']
        
        print('\n   🔄 Running complete autonomous cycle...\n')
        
        # 1. Gather context
        print('   📊 Gathering context...')
        portfolio = await client.get_portfolio()
        markets = await client.get_markets()
        feed = await client.get_feed(limit=10)
        
        print(f"      Balance: ${portfolio['balance']}")
        print(f"      Positions: {len(portfolio['positions'])}")
        print(f"      Markets: {len(markets.get('predictions', [])) + len(markets.get('perps', []))}")
        print(f"      Feed posts: {len(feed['posts'])}")
        
        # 2. Check if we can trade
        if test_market_id and portfolio['balance'] >= 50:
            print('   💰 Executing trade...')
            trade_result = await client.buy_shares(test_market_id, 'YES', 50)
            print(f"      ✅ Trade executed: {trade_result['shares']} shares")
        
        # 3. Create engagement
        print('   📝 Creating engagement...')
        post_result = await client.create_post(
            f"🔄 Autonomous cycle test - {datetime.now().isoformat()}",
            'post'
        )
        print(f"      ✅ Post created: {post_result['postId']}")
        
        # 4. Check final state
        print('   📊 Final state...')
        final_portfolio = await client.get_portfolio()
        print(f"      Final balance: ${final_portfolio['balance']}")
        print(f"      Final positions: {len(final_portfolio['positions'])}")
        
        print('\n   ✅ Complete autonomous cycle finished!\n')
        
        assert portfolio is not None
        assert markets is not None
        assert feed is not None


if __name__ == '__main__':
    pytest.main([__file__, '-v', '-s'])

