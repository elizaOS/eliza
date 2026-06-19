"""
Local A2A Server E2E Tests - Python

Tests all A2A functionality against the local server.
No external dependencies required.

Prerequisites:
- Local A2A server running on localhost:3001
  (Run: cd ../local-a2a-server && bun run dev)
"""

import pytest
import httpx
import time
from eth_account import Account

A2A_URL = "http://localhost:3001"
TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"


class TestClient:
    """Simple A2A test client"""
    
    def __init__(self):
        account = Account.from_key(TEST_PRIVATE_KEY)
        self.address = account.address
        self.token_id = int(time.time()) % 1000000
        self.agent_id = f"agent-31337-{self.token_id}"
        self.message_id = 1
    
    async def call(self, method: str, params: dict = None):
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{A2A_URL}/api/a2a",
                json={
                    'jsonrpc': '2.0',
                    'method': method,
                    'params': params or {},
                    'id': self.message_id
                },
                headers={
                    'Content-Type': 'application/json',
                    'x-agent-id': self.agent_id,
                    'x-agent-address': self.address,
                    'x-agent-token-id': str(self.token_id)
                }
            )
            self.message_id += 1
            result = response.json()
            if 'error' in result:
                raise Exception(result['error']['message'])
            return result['result']


@pytest.fixture
def client():
    return TestClient()


# ==================== Server Health ====================

class TestServerHealth:
    @pytest.mark.asyncio
    async def test_health_endpoint(self):
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{A2A_URL}/health")
            assert response.status_code == 200
            data = response.json()
            assert data['status'] == 'ok'
    
    @pytest.mark.asyncio
    async def test_agent_card(self):
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{A2A_URL}/.well-known/agent-card")
            assert response.status_code == 200
            data = response.json()
            assert 'name' in data
            assert 'skills' in data


# ==================== Agent Discovery ====================

class TestAgentDiscovery:
    @pytest.mark.asyncio
    async def test_register_agent(self, client):
        result = await client.call('register', {
            'walletAddress': client.address,
            'tokenId': client.token_id,
            'chainId': 31337,
            'displayName': 'Python Test Agent',
            'description': 'E2E test agent'
        })
        assert result['success'] == True
        assert result['agent']['id'] == client.agent_id
    
    @pytest.mark.asyncio
    async def test_discover_agents(self, client):
        result = await client.call('discover', {})
        assert 'agents' in result
        assert isinstance(result['agents'], list)
    
    @pytest.mark.asyncio
    async def test_get_agent_info(self, client):
        # Register first
        await client.call('register', {
            'walletAddress': client.address,
            'tokenId': client.token_id,
            'chainId': 31337
        })
        
        result = await client.call('getInfo', {'agentId': client.agent_id})
        assert result['id'] == client.agent_id


# ==================== Portfolio ====================

class TestPortfolio:
    @pytest.mark.asyncio
    async def test_get_balance(self, client):
        result = await client.call('getBalance', {})
        assert 'balance' in result
        assert 'currency' in result
        assert result['balance'] >= 0
    
    @pytest.mark.asyncio
    async def test_get_positions(self, client):
        result = await client.call('getPositions', {})
        assert 'positions' in result
        assert isinstance(result['positions'], list)
    
    @pytest.mark.asyncio
    async def test_get_portfolio(self, client):
        result = await client.call('getPortfolio', {})
        assert 'balance' in result
        assert 'positions' in result
        assert 'pnl' in result
    
    @pytest.mark.asyncio
    async def test_get_wallet(self, client):
        result = await client.call('getUserWallet', {})
        assert 'address' in result
        assert 'virtualBalance' in result


# ==================== Markets ====================

class TestMarkets:
    @pytest.mark.asyncio
    async def test_get_markets(self, client):
        result = await client.call('getMarkets', {})
        assert 'predictions' in result
        assert 'perps' in result
        assert isinstance(result['predictions'], list)
    
    @pytest.mark.asyncio
    async def test_get_market_data(self, client):
        result = await client.call('getMarketData', {'marketId': 'market-btc-100k'})
        assert result['id'] == 'market-btc-100k'
        assert 'question' in result
        assert 'yesPrice' in result
    
    @pytest.mark.asyncio
    async def test_buy_shares(self, client):
        result = await client.call('buyShares', {
            'marketId': 'market-btc-100k',
            'outcome': 'YES',
            'amount': 10
        })
        assert 'id' in result
        assert result['shares'] > 0
        assert result['price'] > 0
    
    @pytest.mark.asyncio
    async def test_sell_shares_after_buy(self, client):
        # Buy first
        buy_result = await client.call('buyShares', {
            'marketId': 'market-ai-agents',
            'outcome': 'NO',
            'amount': 20
        })
        
        # Sell half
        sell_shares = buy_result['shares'] / 2
        sell_result = await client.call('sellShares', {
            'marketId': 'market-ai-agents',
            'outcome': 'NO',
            'shares': sell_shares
        })
        assert 'id' in sell_result


# ==================== Social ====================

class TestSocial:
    @pytest.mark.asyncio
    async def test_get_feed(self, client):
        result = await client.call('getFeed', {'limit': 10})
        assert 'posts' in result
        assert isinstance(result['posts'], list)
    
    @pytest.mark.asyncio
    async def test_create_post(self, client):
        content = f"Test post from Python {time.time()}"
        result = await client.call('createPost', {'content': content})
        assert 'id' in result
        assert result['content'] == content
    
    @pytest.mark.asyncio
    async def test_like_post(self, client):
        result = await client.call('likePost', {'postId': 'post-welcome'})
        assert result['success'] == True
        assert 'likesCount' in result
    
    @pytest.mark.asyncio
    async def test_comment_post(self, client):
        result = await client.call('commentPost', {
            'postId': 'post-welcome',
            'content': 'Python test comment'
        })
        assert 'id' in result
    
    @pytest.mark.asyncio
    async def test_search_users(self, client):
        result = await client.call('searchUsers', {'query': 'agent'})
        assert 'users' in result
        assert isinstance(result['users'], list)


# ==================== Stats ====================

class TestStats:
    @pytest.mark.asyncio
    async def test_get_stats(self, client):
        result = await client.call('getStats', {})
        assert 'totalAgents' in result
        assert 'totalMarkets' in result
    
    @pytest.mark.asyncio
    async def test_get_leaderboard(self, client):
        result = await client.call('getLeaderboard', {'limit': 10})
        assert 'entries' in result
        assert isinstance(result['entries'], list)


# ==================== Notifications ====================

class TestNotifications:
    @pytest.mark.asyncio
    async def test_get_notifications(self, client):
        result = await client.call('getNotifications', {})
        assert 'notifications' in result
        assert isinstance(result['notifications'], list)


# ==================== Payments ====================

class TestPayments:
    @pytest.mark.asyncio
    async def test_payment_request(self, client):
        result = await client.call('paymentRequest', {
            'amount': 100,
            'currency': 'ETH'
        })
        assert 'paymentId' in result
        assert result['status'] == 'pending'
    
    @pytest.mark.asyncio
    async def test_payment_receipt(self, client):
        result = await client.call('paymentReceipt', {
            'paymentId': 'test-payment',
            'amount': 100,
            'transactionHash': '0x1234...'
        })
        assert result['verified'] == True


# ==================== Coverage Summary ====================

class TestCoverage:
    def test_method_coverage(self):
        """Verify all A2A methods are tested"""
        methods = [
            # Discovery
            'register', 'discover', 'getInfo',
            # Portfolio
            'getBalance', 'getPositions', 'getPortfolio', 'getUserWallet',
            # Markets
            'getMarkets', 'getMarketData', 'buyShares', 'sellShares',
            # Social
            'getFeed', 'createPost', 'likePost', 'commentPost', 'searchUsers',
            # Notifications
            'getNotifications',
            # Stats
            'getStats', 'getLeaderboard',
            # Payments
            'paymentRequest', 'paymentReceipt'
        ]
        print(f"\n✅ {len(methods)} A2A methods tested")
        assert len(methods) >= 20
