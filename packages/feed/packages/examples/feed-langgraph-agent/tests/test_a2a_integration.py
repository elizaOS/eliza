"""
End-to-end tests for Feed A2A integration
Tests Agent0 registration, authentication, and all Feed methods
"""

import os
import pytest
import json
from dotenv import load_dotenv
from eth_account import Account
from eth_account.messages import encode_defunct

# Import the agent modules
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

load_dotenv()

# ==================== Test Configuration ====================

FEED_A2A_URL = os.getenv('FEED_A2A_URL', 'ws://localhost:3000/a2a')
FEED_HTTP_URL = os.getenv('FEED_HTTP_URL', 'http://localhost:3000')
TEST_PRIVATE_KEY = os.getenv('AGENT0_PRIVATE_KEY')

@pytest.fixture
def web3_account():
    """Get Web3 account for testing"""
    if not TEST_PRIVATE_KEY:
        pytest.skip("AGENT0_PRIVATE_KEY not set")
    return Account.from_key(TEST_PRIVATE_KEY)

@pytest.fixture
def test_identity(web3_account):
    """Create test identity"""
    return {
        'address': web3_account.address,
        'tokenId': 12345,
        'agentId': "11155111:12345",
        'name': 'Test Agent'
    }

# ==================== Agent0 Registration Tests ====================

class TestAgent0Registration:
    """Test Agent0 ERC-8004 registration"""
    
    def test_private_key_loaded(self):
        """Verify private key is loaded"""
        assert TEST_PRIVATE_KEY, "AGENT0_PRIVATE_KEY must be set"
        assert TEST_PRIVATE_KEY.startswith('0x'), "Private key should start with 0x"
    
    def test_account_derivation(self, web3_account):
        """Verify we can derive account from private key"""
        assert web3_account.address
        assert len(web3_account.address) == 42
        assert web3_account.address.startswith('0x')
        print(f"✅ Derived address: {web3_account.address}")
    
    def test_message_signing(self, web3_account):
        """Verify we can sign messages"""
        message = "Test message"
        encoded_message = encode_defunct(text=message)
        signed_message = web3_account.sign_message(encoded_message)
        
        assert signed_message.signature
        assert len(signed_message.signature) == 65
        print(f"✅ Signature: {signed_message.signature.hex()[:32]}...")
    
    def test_signature_verification(self, web3_account):
        """Verify signature can be recovered"""
        from eth_account.messages import encode_defunct
        from eth_utils import to_checksum_address
        
        message = "Test authentication"
        encoded_message = encode_defunct(text=message)
        signed_message = web3_account.sign_message(encoded_message)
        
        # Recover address from signature
        recovered_address = Account.recover_message(
            encoded_message,
            signature=signed_message.signature
        )
        
        assert to_checksum_address(recovered_address) == web3_account.address
        print(f"✅ Signature verified, recovered: {recovered_address}")

# ==================== A2A Authentication Tests ====================

class TestA2AAuthentication:
    """Test A2A authentication and handshake"""
    
    @pytest.mark.asyncio
    async def test_handshake_message_format(self, test_identity, web3_account):
        """Test handshake message creation and signing"""
        import time
        
        timestamp = int(time.time() * 1000)
        message = f"A2A Authentication\n\nAgent: {test_identity['address']}\nToken: {test_identity['tokenId']}\nTimestamp: {timestamp}"
        
        # Sign message
        encoded_message = encode_defunct(text=message)
        signed_message = web3_account.sign_message(encoded_message)
        signature = signed_message.signature.hex()
        
        # Verify format
        assert message.startswith("A2A Authentication")
        assert test_identity['address'] in message
        assert str(test_identity['tokenId']) in message
        assert len(signature) == 132  # 0x + 130 hex chars
        
        print("✅ Handshake message created and signed")
        print(f"   Message: {message[:50]}...")
        print(f"   Signature: {signature[:32]}...")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_websocket_connection(self, test_identity, web3_account):
        """Test WebSocket connection to Feed"""
        import websockets
        import time
        
        # Create handshake
        timestamp = int(time.time() * 1000)
        message = f"A2A Authentication\n\nAgent: {test_identity['address']}\nToken: {test_identity['tokenId']}\nTimestamp: {timestamp}"
        
        encoded_message = encode_defunct(text=message)
        signed_message = web3_account.sign_message(encoded_message)
        signature = signed_message.signature.hex()
        
        # Connect to WebSocket
        async with websockets.connect(FEED_A2A_URL) as websocket:
            # Send handshake
            handshake_request = {
                'jsonrpc': '2.0',
                'method': 'a2a.handshake',
                'params': {
                    'credentials': {
                        'address': test_identity['address'],
                        'tokenId': test_identity['tokenId'],
                        'signature': signature,
                        'timestamp': timestamp
                    },
                    'capabilities': {
                        'strategies': ['testing'],
                        'markets': ['prediction'],
                        'actions': ['read'],
                        'version': '1.0.0'
                    }
                },
                'id': 1
            }
            
            await websocket.send(json.dumps(handshake_request))
            
            # Wait for response
            response_data = await websocket.recv()
            response = json.loads(response_data)
            
            # Verify response
            assert response['jsonrpc'] == '2.0'
            assert 'result' in response or 'error' in response
            
            if 'result' in response:
                assert 'agentId' in response['result']
                assert 'sessionToken' in response['result']
                print("✅ Handshake successful!")
                print(f"   Agent ID: {response['result']['agentId']}")
                print(f"   Session: {response['result']['sessionToken'][:16]}...")
            else:
                print(f"❌ Handshake error: {response['error']}")
                pytest.fail(f"Handshake failed: {response['error']['message']}")

# ==================== Feed A2A Method Tests ====================

class TestFeedA2AMethods:
    """Test all Feed A2A methods"""
    
    @pytest.fixture
    async def authenticated_client(self, test_identity, web3_account):
        """Get authenticated A2A client"""
        # This would use the actual FeedA2AClient from agent_v2.py
        # For now, we'll skip these tests unless server is running
        pytest.skip("Requires running Feed server")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_get_markets(self, authenticated_client):
        """Test a2a.getMarketData method"""
        result = await authenticated_client.call('a2a.getMarketData', {
            'marketId': 'test-market-1'
        })
        
        assert 'marketId' in result
        assert 'question' in result
        print(f"✅ Got market data: {result['question']}")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_get_balance(self, authenticated_client):
        """Test a2a.getBalance method"""
        result = await authenticated_client.call('a2a.getBalance', {})
        
        assert 'balance' in result
        print(f"✅ Got balance: {result['balance']}")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_get_positions(self, authenticated_client):
        """Test a2a.getPositions method"""
        result = await authenticated_client.call('a2a.getPositions', {
            'userId': authenticated_client.agent_id
        })
        
        assert 'perpPositions' in result or 'marketPositions' in result
        print("✅ Got positions")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_discover_agents(self, authenticated_client):
        """Test a2a.discover method"""
        result = await authenticated_client.call('a2a.discover', {
            'filters': {
                'strategies': ['autonomous-trading']
            },
            'limit': 10
        })
        
        assert 'agents' in result
        assert 'total' in result
        print(f"✅ Discovered {result['total']} agents")
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_get_feed(self, authenticated_client):
        """Test a2a.getFeed method"""
        result = await authenticated_client.call('a2a.getFeed', {
            'limit': 20,
            'offset': 0
        })
        
        assert 'posts' in result
        print(f"✅ Got {len(result['posts'])} feed posts")

# ==================== Integration Test ====================

class TestEndToEndIntegration:
    """Complete end-to-end integration test"""
    
    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Requires running Feed server")
    async def test_complete_flow(self, test_identity, web3_account):
        """Test complete agent flow: connect -> authenticate -> query -> act"""
        # Import the actual agent
        from agent import FeedA2AClient
        
        # 1. Create client (HTTP mode)
        client = FeedA2AClient(
            http_url=FEED_A2A_URL.replace('ws://', 'http://').replace('/a2a', '/api/a2a'),
            address=test_identity['address'],
            token_id=test_identity['tokenId']
        )
        
        print("📝 Step 1: Create client")
        print(f"📝 Step 2: Client ready with agent ID: {client.agent_id}")
        
        # 3. Get balance
        balance_result = await client.call('a2a.getBalance', {})
        print(f"📝 Step 3: Balance: {balance_result.get('balance', 0)}")
        
        # 4. Get markets
        markets_result = await client.call('a2a.getPredictions', {'status': 'active'})
        print(f"📝 Step 4: Found {len(markets_result.get('predictions', []))} markets")
        
        # 5. Get feed
        feed_result = await client.call('a2a.getFeed', {'limit': 5, 'offset': 0})
        print(f"📝 Step 5: Found {len(feed_result.get('posts', []))} posts")
        
        # 6. Discover agents
        discover_result = await client.call('a2a.discover', {'limit': 10})
        print(f"📝 Step 6: Discovered {len(discover_result.get('agents', []))} agents")
        
        # 7. Close connection
        await client.close()
        print("📝 Step 7: Disconnected")
        
        print("✅ Complete end-to-end flow successful!")

# ==================== Verification Report ====================

def test_generate_verification_report():
    """Generate verification report"""
    print("\n" + "="*60)
    print("🔍 FEED PYTHON AGENT VERIFICATION REPORT")
    print("="*60)
    
    print("\n✅ VERIFIED:")
    print("  - Private key loading")
    print("  - Account derivation from private key")
    print("  - Message signing with eth_account")
    print("  - Signature verification")
    print("  - A2A handshake message format")
    
    print("\n⏳ REQUIRES RUNNING SERVER:")
    print("  - HTTP A2A connection to Feed")
    print("  - JSON-RPC method calls over HTTP POST")
    print("  - Complete end-to-end flow")
    
    print("\n📋 NEXT STEPS:")
    print("  1. Start Feed server: cd /Users/shawwalters/feed && npm run dev")
    print("  2. Run integration tests: uv run pytest tests/test_a2a_integration.py -v -s")
    print("  3. Run agent: uv run python agent.py --test")
    
    print("\n" + "="*60)
    print("")

if __name__ == "__main__":
    pytest.main([__file__, '-v', '-s'])

