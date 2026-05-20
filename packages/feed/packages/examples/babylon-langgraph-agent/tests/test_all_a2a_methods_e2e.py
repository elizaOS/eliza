"""
Coverage E2E tests for the Babylon LangGraph example client.
Tests against a real server running on localhost:3000.

This suite verifies that the methods wrapped by the example client are:
1. Available on the client
2. Callable against a live server or return expected errors
3. Returning the expected response structures
"""

import pytest
import os
from agent import BabylonA2AClient, A2AError

# Test configuration
TEST_CONFIG = {
    'http_url': os.getenv('BABYLON_A2A_URL', 'http://localhost:3000/api/a2a'),
    'address': os.getenv('AGENT0_ADDRESS', '0x' + '1' * 40),
    'token_id': int(os.getenv('AGENT0_TOKEN_ID', '999999')),
    'chain_id': 11155111
}

@pytest.fixture
async def client():
    """Create and connect A2A client"""
    # Check if server is running
    import httpx
    try:
        async with httpx.AsyncClient() as c:
            response = await c.get('http://localhost:3000/api/health', timeout=5.0)
            if response.status_code != 200:
                pytest.skip('Babylon server not running on localhost:3000')
    except Exception:
        pytest.skip('Babylon server not running on localhost:3000. Run: bun run dev')
    
    client = BabylonA2AClient(**TEST_CONFIG)
    # Test connection
    try:
        await client.call('a2a.getBalance', {})
    except A2AError:
        pass  # Expected if user doesn't exist
    return client

@pytest.mark.asyncio
class TestAgentDiscovery:
    """Agent Discovery (2 methods)"""
    
    async def test_discover_agents(self, client):
        result = await client.call('a2a.discover', {})
        assert 'agents' in result
        assert isinstance(result['agents'], list)
    
    async def test_get_agent_info(self, client):
        try:
            result = await client.call('a2a.getInfo', {'agentId': 'agent-1'})
            assert 'agentId' in result
        except A2AError:
            pass  # Expected if agent doesn't exist

@pytest.mark.asyncio
class TestMarketOperations:
    """Market Operations (8 methods)"""
    
    async def test_get_predictions(self, client):
        result = await client.get_predictions()
        assert 'predictions' in result
        assert isinstance(result['predictions'], list)
    
    async def test_get_perpetuals(self, client):
        result = await client.get_perpetuals()
        assert 'perpetuals' in result
        assert isinstance(result['perpetuals'], list)
    
    async def test_get_trades(self, client):
        result = await client.get_trades()
        assert 'trades' in result
        assert isinstance(result['trades'], list)
    
    async def test_get_trade_history(self, client):
        try:
            result = await client.get_trade_history(client.agent_id)
            assert 'trades' in result
        except A2AError:
            pass

@pytest.mark.asyncio
class TestSocialFeatures:
    """Social Features (11 methods)"""
    
    async def test_get_feed(self, client):
        result = await client.call('a2a.getFeed', {'limit': 10})
        assert 'posts' in result
        assert isinstance(result['posts'], list)
    
    async def test_get_post(self, client):
        try:
            result = await client.get_post('test-post-id')
            assert result is not None
        except A2AError:
            pass
    
    async def test_get_comments(self, client):
        try:
            result = await client.get_comments('test-post-id')
            assert 'comments' in result
        except A2AError:
            pass
    
    async def test_get_trending_tags(self, client):
        result = await client.get_trending_tags()
        assert 'tags' in result
        assert isinstance(result['tags'], list)
    
    async def test_get_posts_by_tag(self, client):
        try:
            result = await client.get_posts_by_tag('test-tag')
            assert 'posts' in result
        except A2AError:
            pass

@pytest.mark.asyncio
class TestUserManagement:
    """User Management (7 methods)"""
    
    async def test_get_user_profile(self, client):
        try:
            result = await client.get_user_profile(client.agent_id)
            assert result is not None
        except A2AError:
            pass
    
    async def test_search_users(self, client):
        result = await client.search_users('test')
        assert 'users' in result
        assert isinstance(result['users'], list)
    
    async def test_get_followers(self, client):
        try:
            result = await client.get_followers(client.agent_id)
            assert 'followers' in result
        except A2AError:
            pass
    
    async def test_get_following(self, client):
        try:
            result = await client.get_following(client.agent_id)
            assert 'following' in result
        except A2AError:
            pass

@pytest.mark.asyncio
class TestMessaging:
    """Messaging (6 methods)"""
    
    async def test_get_chats(self, client):
        result = await client.get_chats()
        assert 'chats' in result
        assert isinstance(result['chats'], list)
    
    async def test_get_unread_count(self, client):
        result = await client.get_unread_count()
        assert 'count' in result
        assert isinstance(result['count'], int)
    
    async def test_get_group_invites(self, client):
        result = await client.get_group_invites()
        assert 'invites' in result
        assert isinstance(result['invites'], list)

@pytest.mark.asyncio
class TestNotifications:
    """Notifications (5 methods)"""
    
    async def test_get_notifications(self, client):
        result = await client.get_notifications()
        assert 'notifications' in result
        assert isinstance(result['notifications'], list)

@pytest.mark.asyncio
class TestStatsDiscovery:
    """Stats & Discovery (13 methods)"""
    
    async def test_get_leaderboard(self, client):
        result = await client.get_leaderboard()
        assert 'leaderboard' in result
        assert isinstance(result['leaderboard'], list)
    
    async def test_get_system_stats(self, client):
        result = await client.get_system_stats()
        assert result is not None
    
    async def test_get_referrals(self, client):
        result = await client.get_referrals()
        assert 'referrals' in result
        assert isinstance(result['referrals'], list)
    
    async def test_get_referral_stats(self, client):
        result = await client.get_referral_stats()
        assert result is not None
    
    async def test_get_referral_code(self, client):
        result = await client.get_referral_code()
        assert 'code' in result
        assert 'url' in result
    
    async def test_get_reputation(self, client):
        result = await client.get_reputation()
        assert result is not None
    
    async def test_get_organizations(self, client):
        result = await client.get_organizations()
        assert 'organizations' in result
        assert isinstance(result['organizations'], list)

@pytest.mark.asyncio
class TestPortfolio:
    """Portfolio (3 methods)"""
    
    async def test_get_balance(self, client):
        result = await client.call('a2a.getBalance', {})
        assert 'balance' in result
        assert isinstance(result['balance'], (int, float))
    
    async def test_get_positions(self, client):
        result = await client.call('a2a.getPositions', {})
        assert 'perpPositions' in result or 'marketPositions' in result

@pytest.mark.asyncio
class TestMethodAvailability:
    """Verify the example client methods are available"""
    
    async def test_all_methods_available(self, client):
        """Check that the expected example client methods are available"""
        expected_methods = [
            # Trading
            'get_predictions', 'get_perpetuals', 'sell_shares',
            'open_position', 'close_position', 'get_trades', 'get_trade_history',
            # Social
            'get_post', 'delete_post', 'like_post', 'unlike_post', 'share_post',
            'get_comments', 'create_comment', 'delete_comment', 'like_comment',
            # User Management
            'get_user_profile', 'update_profile', 'follow_user', 'unfollow_user',
            'get_followers', 'get_following', 'search_users',
            # Messaging
            'get_chats', 'get_chat_messages', 'send_message',
            'create_group', 'leave_chat', 'get_unread_count',
            # Notifications
            'get_notifications', 'mark_notifications_read',
            'get_group_invites', 'accept_group_invite', 'decline_group_invite',
            # Stats
            'get_leaderboard', 'get_user_stats', 'get_system_stats',
            'get_referrals', 'get_referral_stats', 'get_referral_code',
            'get_reputation', 'get_reputation_breakdown',
            'get_trending_tags', 'get_posts_by_tag', 'get_organizations'
        ]
        
        missing_methods = []
        for method in expected_methods:
            if not hasattr(client, method):
                missing_methods.append(method)
        
        if missing_methods:
            print(f'❌ Missing methods: {missing_methods}')
        
        assert len(missing_methods) == 0, f'Missing {len(missing_methods)} methods'
        assert len(expected_methods) >= 40, 'Should track the current client method inventory'
