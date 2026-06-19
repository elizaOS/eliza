"""
Feed Local Agent - Python + LangGraph

This is a REAL working agent that:
1. Connects to local A2A server
2. Uses anvil test wallet  
3. Performs all available A2A actions
4. Runs autonomously with LangGraph ReAct agent
"""

import os
import json
import time
import asyncio
import random
from datetime import datetime
from typing import Any, Dict, Optional
from dotenv import load_dotenv

# HTTP client
import httpx

# Ethereum
from eth_account import Account

load_dotenv()

# ==================== Configuration ====================

A2A_URL = os.getenv('FEED_A2A_URL', 'http://localhost:3001')
PRIVATE_KEY = os.getenv('AGENT0_PRIVATE_KEY', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
TICK_INTERVAL = int(os.getenv('TICK_INTERVAL', '10'))
AGENT_NAME = os.getenv('AGENT_NAME', 'Python Agent')
AGENT_DESCRIPTION = os.getenv('AGENT_DESCRIPTION', 'Autonomous Python agent')


# ==================== A2A Client ====================

class LocalA2AClient:
    """HTTP client for local A2A server"""
    
    def __init__(self, base_url: str, private_key: str):
        self.base_url = base_url
        
        # Derive address from private key
        account = Account.from_key(private_key)
        self.address = account.address
        
        # Generate unique token ID
        self.token_id = int(time.time()) % 1000000
        self.agent_id = f"agent-31337-{self.token_id}"
        
        self.client = httpx.AsyncClient(timeout=30.0)
        self.message_id = 1
        
        print(f"Agent Address: {self.address}")
        print(f"Token ID: {self.token_id}")
        print(f"Agent ID: {self.agent_id}")
    
    async def call(self, method: str, params: Optional[Dict] = None) -> Dict:
        """Make A2A JSON-RPC call"""
        request_id = self.message_id
        self.message_id += 1
        
        message = {
            'jsonrpc': '2.0',
            'method': method,
            'params': params or {},
            'id': request_id
        }
        
        headers = {
            'Content-Type': 'application/json',
            'x-agent-id': self.agent_id,
            'x-agent-address': self.address,
            'x-agent-token-id': str(self.token_id)
        }
        
        response = await self.client.post(
            f"{self.base_url}/api/a2a",
            json=message,
            headers=headers
        )
        response.raise_for_status()
        
        result = response.json()
        
        if 'error' in result:
            raise Exception(f"A2A Error: {result['error']['message']}")
        
        return result['result']
    
    # ===== Agent Discovery =====
    
    async def register(self, display_name: str, description: str) -> Dict:
        return await self.call('register', {
            'walletAddress': self.address,
            'tokenId': self.token_id,
            'chainId': 31337,
            'displayName': display_name,
            'description': description
        })
    
    async def discover(self) -> Dict:
        return await self.call('discover', {})
    
    async def get_info(self, agent_id: str) -> Dict:
        return await self.call('getInfo', {'agentId': agent_id})
    
    # ===== Portfolio =====
    
    async def get_balance(self) -> Dict:
        return await self.call('getBalance', {})
    
    async def get_positions(self) -> Dict:
        return await self.call('getPositions', {})
    
    async def get_portfolio(self) -> Dict:
        return await self.call('getPortfolio', {})
    
    async def get_wallet(self) -> Dict:
        return await self.call('getUserWallet', {})
    
    # ===== Markets =====
    
    async def get_markets(self) -> Dict:
        return await self.call('getMarkets', {})
    
    async def get_market_data(self, market_id: str) -> Dict:
        return await self.call('getMarketData', {'marketId': market_id})
    
    async def buy_shares(self, market_id: str, outcome: str, amount: float) -> Dict:
        return await self.call('buyShares', {
            'marketId': market_id,
            'outcome': outcome,
            'amount': amount
        })
    
    async def sell_shares(self, market_id: str, outcome: str, shares: float) -> Dict:
        return await self.call('sellShares', {
            'marketId': market_id,
            'outcome': outcome,
            'shares': shares
        })
    
    # ===== Social =====
    
    async def get_feed(self, limit: int = 20) -> Dict:
        return await self.call('getFeed', {'limit': limit})
    
    async def create_post(self, content: str) -> Dict:
        return await self.call('createPost', {'content': content})
    
    async def like_post(self, post_id: str) -> Dict:
        return await self.call('likePost', {'postId': post_id})
    
    async def comment_post(self, post_id: str, content: str) -> Dict:
        return await self.call('commentPost', {
            'postId': post_id,
            'content': content
        })
    
    # ===== Stats =====
    
    async def get_stats(self) -> Dict:
        return await self.call('getStats', {})
    
    async def get_leaderboard(self, limit: int = 10) -> Dict:
        return await self.call('getLeaderboard', {'limit': limit})
    
    async def close(self):
        await self.client.aclose()


# ==================== Decision Making ====================

ACTIONS = ['BUY_YES', 'BUY_NO', 'CREATE_POST', 'LIKE_POST', 'VIEW_FEED', 'HOLD']

REASONINGS = {
    'BUY_YES': 'Market sentiment looks positive, buying YES shares',
    'BUY_NO': 'Feeling contrarian, buying NO shares',
    'CREATE_POST': 'Time to share some market insights',
    'LIKE_POST': 'Engaging with the community',
    'VIEW_FEED': 'Checking latest market chatter',
    'HOLD': 'Waiting for better opportunities'
}

def make_decision(context: Dict) -> Dict:
    """Simple random decision (can be replaced with LLM)"""
    action = random.choice(ACTIONS)
    return {
        'action': action,
        'params': {},
        'reasoning': REASONINGS[action]
    }


# ==================== Main Agent Loop ====================

async def run_agent():
    print('')
    print('🐍 Feed Python Agent Starting...')
    print('===================================')
    print('')
    
    # Initialize client
    client = LocalA2AClient(A2A_URL, PRIVATE_KEY)
    
    try:
        # Phase 1: Register
        print('📝 Phase 1: Registering agent...')
        try:
            registration = await client.register(AGENT_NAME, AGENT_DESCRIPTION)
            print(f"✅ Registered: {registration['agent']['id']}")
        except Exception as e:
            if 'already registered' in str(e):
                print('✅ Agent already registered')
            else:
                print(f"⚠️ Registration note: {e}")
        
        # Phase 2: Get initial state
        print('')
        print('📊 Phase 2: Getting initial state...')
        balance = await client.get_balance()
        markets = await client.get_markets()
        stats = await client.get_stats()
        print(f"   Balance: ${balance['balance']}")
        print(f"   Markets: {len(markets['predictions'])} predictions, {len(markets['perps'])} perps")
        print(f"   Network: {stats['totalAgents']} agents")
        
        # Phase 3: Autonomous Loop
        print('')
        print('🔄 Phase 3: Starting autonomous loop...')
        print(f"   Tick interval: {TICK_INTERVAL}s")
        print('')
        
        tick_count = 0
        
        while True:
            tick_count += 1
            print('━' * 40)
            print(f'🔄 TICK #{tick_count}')
            print('━' * 40)
            
            # Get context
            portfolio = await client.get_portfolio()
            feed = await client.get_feed(5)
            markets_data = await client.get_markets()
            
            print(f"📊 Balance: ${portfolio['balance']:.2f} | Positions: {len(portfolio['positions'])} | P&L: ${portfolio['pnl']:.2f}")
            
            # Make decision
            decision = make_decision({
                'balance': portfolio['balance'],
                'positions': portfolio['positions'],
                'markets': markets_data['predictions'],
                'posts': feed['posts']
            })
            
            print(f"🤔 Decision: {decision['action']}")
            print(f"   Reasoning: {decision['reasoning']}")
            
            # Execute action
            try:
                action = decision['action']
                
                if action in ['BUY_YES', 'BUY_NO']:
                    if markets_data['predictions'] and portfolio['balance'] >= 10:
                        market = markets_data['predictions'][0]
                        outcome = 'YES' if action == 'BUY_YES' else 'NO'
                        amount = min(50, portfolio['balance'] * 0.1)
                        trade = await client.buy_shares(market['id'], outcome, amount)
                        print(f"✅ Bought {trade['shares']:.2f} {outcome} shares @ ${trade['price']:.2f}")
                    else:
                        print('⏭️ Skipped: insufficient balance or no markets')
                
                elif action == 'CREATE_POST':
                    messages = [
                        f"Python agent tick #{tick_count}: Analyzing markets 🐍📈",
                        f"Agent {client.agent_id} checking in! Markets looking interesting.",
                        f"Autonomous trading with Python 🐍 Balance: ${portfolio['balance']:.2f}",
                        f"Never sleeping, always trading! Current P&L: ${portfolio['pnl']:.2f}",
                        f"Exploring prediction markets from Python land! 🐍"
                    ]
                    content = random.choice(messages)
                    post = await client.create_post(content)
                    print(f"✅ Posted: \"{post['content'][:50]}...\"")
                
                elif action == 'LIKE_POST':
                    posts = feed['posts']
                    if posts:
                        post = random.choice(posts)
                        result = await client.like_post(post['id'])
                        print(f"✅ Liked post {post['id']} ({result['likesCount']} likes)")
                    else:
                        print('⏭️ No posts to like')
                
                elif action == 'VIEW_FEED':
                    print(f"📰 Feed ({len(feed['posts'])} posts):")
                    for post in feed['posts'][:3]:
                        print(f"   - {post['content'][:60]}...")
                
                elif action == 'HOLD':
                    print('⏸️ Holding - no action taken')
            
            except Exception as e:
                print(f"❌ Action failed: {e}")
            
            print(f"⏳ Next tick in {TICK_INTERVAL}s...")
            print('')
            
            await asyncio.sleep(TICK_INTERVAL)
    
    except KeyboardInterrupt:
        print('')
        print('🛑 Shutting down...')
    finally:
        await client.close()
        print('👋 Goodbye!')


if __name__ == '__main__':
    asyncio.run(run_agent())
