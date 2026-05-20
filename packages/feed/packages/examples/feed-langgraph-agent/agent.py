"""
Feed Autonomous Agent - Python + LangGraph + HTTP A2A

Production-ready autonomous trading agent that:
- Connects to Feed via HTTP A2A protocol (recommended)
- Makes autonomous decisions using LangGraph ReAct agent
- Trades prediction markets, posts to feed, manages portfolio
- Maintains memory of recent actions
- Includes proper validation and error handling
"""

import os
import json
import time
import asyncio
import argparse
from datetime import datetime
from typing import Any, Dict, Optional
from dotenv import load_dotenv

# LangChain & LangGraph
from langchain_groq import ChatGroq
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

# HTTP & Web3
import httpx
from eth_account import Account

load_dotenv()

# ==================== Custom Exceptions ====================

class A2AError(Exception):
    """A2A protocol error"""
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"A2A Error [{code}]: {message}")

class ValidationError(Exception):
    """Input validation error"""
    pass

# ==================== HTTP A2A Client ====================

class FeedA2AClient:
    """HTTP client for the Feed A2A methods wrapped by this example."""
    
    def __init__(self, http_url: str, address: str, token_id: int, chain_id: int = 11155111):
        self.http_url = http_url
        self.address = address
        self.token_id = token_id
        self.chain_id = chain_id
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
        self.message_id = 1
        self.agent_id = f"{chain_id}:{token_id}"
        
    async def call(self, method: str, params: Optional[Dict] = None) -> Dict:
        """Make JSON-RPC call - raises exceptions on error"""
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
        
        response = await self.client.post(self.http_url, json=message, headers=headers)
        response.raise_for_status()  # Raises HTTPStatusError on 4xx/5xx
        
        result = response.json()
        
        # Raise A2AError if RPC error
        if 'error' in result:
            error = result['error']
            raise A2AError(
                code=error.get('code', -1),
                message=error.get('message', 'Unknown error'),
                data=error.get('data')
            )
            
        return result['result']
    
    # ===== Trading Methods =====
    
    async def get_predictions(
        self, user_id: Optional[str] = None, status: Optional[str] = None
    ) -> Dict:
        """Get all prediction markets"""
        params = {}
        if user_id or status:
            params = {'userId': user_id, 'status': status}
        return await self.call('a2a.getPredictions', params)
    
    async def get_perpetuals(self) -> Dict:
        """Get all perpetual markets"""
        return await self.call('a2a.getPerpetuals', {})
    
    async def sell_shares(self, position_id: str, shares: float) -> Dict:
        """Sell prediction market shares"""
        return await self.call('a2a.sellShares', {'positionId': position_id, 'shares': shares})
    
    async def open_position(
        self, ticker: str, side: str, amount: float, leverage: int
    ) -> Dict:
        """Open perpetual position"""
        params = {
            'ticker': ticker,
            'side': side,
            'amount': amount,
            'leverage': leverage,
        }
        return await self.call('a2a.openPosition', params)
    
    async def close_position(self, position_id: str) -> Dict:
        """Close perpetual position"""
        return await self.call('a2a.closePosition', {'positionId': position_id})
    
    async def get_trades(
        self, limit: Optional[int] = None, market_id: Optional[str] = None
    ) -> Dict:
        """Get recent trades"""
        params = {}
        if limit:
            params['limit'] = limit
        if market_id:
            params['marketId'] = market_id
        return await self.call('a2a.getTrades', params)
    
    async def get_trade_history(self, user_id: str, limit: Optional[int] = None) -> Dict:
        """Get trade history for user"""
        params = {'userId': user_id}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getTradeHistory', params)
    
    # ===== Social Methods =====
    
    async def get_post(self, post_id: str) -> Dict:
        """Get single post"""
        return await self.call('a2a.getPost', {'postId': post_id})
    
    async def delete_post(self, post_id: str) -> Dict:
        """Delete own post"""
        return await self.call('a2a.deletePost', {'postId': post_id})
    
    async def like_post(self, post_id: str) -> Dict:
        """Like a post"""
        return await self.call('a2a.likePost', {'postId': post_id})
    
    async def unlike_post(self, post_id: str) -> Dict:
        """Unlike a post"""
        return await self.call('a2a.unlikePost', {'postId': post_id})
    
    async def share_post(self, post_id: str, comment: Optional[str] = None) -> Dict:
        """Share/repost a post"""
        params = {'postId': post_id}
        if comment:
            params['comment'] = comment
        return await self.call('a2a.sharePost', params)
    
    async def get_comments(self, post_id: str, limit: Optional[int] = None) -> Dict:
        """Get comments on a post"""
        params = {'postId': post_id}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getComments', params)
    
    async def create_comment(self, post_id: str, content: str) -> Dict:
        """Create comment on a post"""
        return await self.call('a2a.createComment', {'postId': post_id, 'content': content})
    
    async def delete_comment(self, comment_id: str) -> Dict:
        """Delete own comment"""
        return await self.call('a2a.deleteComment', {'commentId': comment_id})
    
    async def like_comment(self, comment_id: str) -> Dict:
        """Like a comment"""
        return await self.call('a2a.likeComment', {'commentId': comment_id})
    
    # ===== User Management =====
    
    async def get_user_profile(self, user_id: str) -> Dict:
        """Get user profile"""
        return await self.call('a2a.getUserProfile', {'userId': user_id})
    
    async def update_profile(self, display_name: Optional[str] = None, bio: Optional[str] = None, 
                            username: Optional[str] = None, profile_image_url: Optional[str] = None) -> Dict:
        """Update own profile"""
        params = {}
        if display_name:
            params['displayName'] = display_name
        if bio:
            params['bio'] = bio
        if username:
            params['username'] = username
        if profile_image_url:
            params['profileImageUrl'] = profile_image_url
        return await self.call('a2a.updateProfile', params)
    
    async def follow_user(self, user_id: str) -> Dict:
        """Follow a user"""
        return await self.call('a2a.followUser', {'userId': user_id})
    
    async def unfollow_user(self, user_id: str) -> Dict:
        """Unfollow a user"""
        return await self.call('a2a.unfollowUser', {'userId': user_id})
    
    async def get_followers(self, user_id: str, limit: Optional[int] = None) -> Dict:
        """Get user's followers"""
        params = {'userId': user_id}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getFollowers', params)
    
    async def get_following(self, user_id: str, limit: Optional[int] = None) -> Dict:
        """Get who user follows"""
        params = {'userId': user_id}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getFollowing', params)
    
    async def search_users(self, query: str, limit: Optional[int] = None) -> Dict:
        """Search for users"""
        params = {'query': query}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.searchUsers', params)
    
    # ===== Messaging =====
    
    async def get_chats(self, filter_type: Optional[str] = None) -> Dict:
        """Get user's chats"""
        params = {}
        if filter_type:
            params['filter'] = filter_type
        return await self.call('a2a.getChats', params)
    
    async def get_chat_messages(self, chat_id: str, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict:
        """Get messages from a chat"""
        params = {'chatId': chat_id}
        if limit:
            params['limit'] = limit
        if offset:
            params['offset'] = offset
        return await self.call('a2a.getChatMessages', params)
    
    async def send_message(self, chat_id: str, content: str) -> Dict:
        """Send message to chat"""
        return await self.call('a2a.sendMessage', {'chatId': chat_id, 'content': content})
    
    async def create_group(self, name: str, member_ids: list, description: Optional[str] = None) -> Dict:
        """Create group chat"""
        params = {'name': name, 'memberIds': member_ids}
        if description:
            params['description'] = description
        return await self.call('a2a.createGroup', params)
    
    async def leave_chat(self, chat_id: str) -> Dict:
        """Leave a chat"""
        return await self.call('a2a.leaveChat', {'chatId': chat_id})
    
    async def get_unread_count(self) -> Dict:
        """Get unread message count"""
        return await self.call('a2a.getUnreadCount', {})
    
    # ===== Notifications =====
    
    async def get_notifications(self, limit: Optional[int] = None) -> Dict:
        """Get notifications"""
        params = {}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getNotifications', params)
    
    async def mark_notifications_read(self, notification_ids: list) -> Dict:
        """Mark notifications as read"""
        return await self.call('a2a.markNotificationsRead', {'notificationIds': notification_ids})
    
    async def get_group_invites(self) -> Dict:
        """Get group chat invites"""
        return await self.call('a2a.getGroupInvites', {})
    
    async def accept_group_invite(self, invite_id: str) -> Dict:
        """Accept group invite"""
        return await self.call('a2a.acceptGroupInvite', {'inviteId': invite_id})
    
    async def decline_group_invite(self, invite_id: str) -> Dict:
        """Decline group invite"""
        return await self.call('a2a.declineGroupInvite', {'inviteId': invite_id})
    
    # ===== Stats & Discovery =====
    
    async def get_leaderboard(self, page: Optional[int] = None, page_size: Optional[int] = None,
                             points_type: Optional[str] = None, min_points: Optional[int] = None) -> Dict:
        """Get leaderboard"""
        params = {}
        if page:
            params['page'] = page
        if page_size:
            params['pageSize'] = page_size
        if points_type:
            params['pointsType'] = points_type
        if min_points:
            params['minPoints'] = min_points
        return await self.call('a2a.getLeaderboard', params)
    
    async def get_user_stats(self, user_id: str) -> Dict:
        """Get user statistics"""
        return await self.call('a2a.getUserStats', {'userId': user_id})
    
    async def get_system_stats(self) -> Dict:
        """Get system statistics"""
        return await self.call('a2a.getSystemStats', {})
    
    async def get_referrals(self) -> Dict:
        """Get user's referrals"""
        return await self.call('a2a.getReferrals', {})
    
    async def get_referral_stats(self) -> Dict:
        """Get referral statistics"""
        return await self.call('a2a.getReferralStats', {})
    
    async def get_referral_code(self) -> Dict:
        """Get referral code/URL"""
        return await self.call('a2a.getReferralCode', {})
    
    async def get_reputation(self, user_id: Optional[str] = None) -> Dict:
        """Get reputation score"""
        params = {}
        if user_id:
            params['userId'] = user_id
        return await self.call('a2a.getReputation', params)
    
    async def get_reputation_breakdown(self, user_id: str) -> Dict:
        """Get detailed reputation breakdown"""
        return await self.call('a2a.getReputationBreakdown', {'userId': user_id})
    
    async def get_trending_tags(self, limit: Optional[int] = None) -> Dict:
        """Get trending tags"""
        params = {}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getTrendingTags', params)
    
    async def get_posts_by_tag(self, tag: str, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict:
        """Get posts by tag"""
        params = {'tag': tag}
        if limit:
            params['limit'] = limit
        if offset:
            params['offset'] = offset
        return await self.call('a2a.getPostsByTag', params)
    
    async def get_organizations(self, limit: Optional[int] = None) -> Dict:
        """Get organizations"""
        params = {}
        if limit:
            params['limit'] = limit
        return await self.call('a2a.getOrganizations', params)
    
    async def close(self):
        """Close HTTP client"""
        await self.client.aclose()

# ==================== Validation ====================

def validate_outcome(outcome: str) -> str:
    """Validate and normalize outcome"""
    outcome = outcome.upper()
    if outcome not in ['YES', 'NO']:
        raise ValidationError(f"outcome must be YES or NO, got: {outcome}")
    return outcome

def validate_amount(amount: float) -> float:
    """Validate trade amount"""
    if amount <= 0:
        raise ValidationError(f"amount must be > 0, got: {amount}")
    if amount > 1000000:
        raise ValidationError(f"amount too large: {amount}")
    return amount

def validate_market_id(market_id: str) -> str:
    """Validate market ID format"""
    if not market_id or not isinstance(market_id, str):
        raise ValidationError(f"invalid market_id: {market_id}")
    return market_id

def validate_content(content: str, max_length: int = 280) -> str:
    """Validate and truncate content"""
    if not content or not isinstance(content, str):
        raise ValidationError("content must be non-empty string")
    return content[:max_length]

# ==================== Memory ====================

action_memory: list[Dict] = []

def add_to_memory(action: str, result: Any):
    """Add action to agent memory"""
    action_memory.append({
        'action': action,
        'result': result,
        'timestamp': datetime.now().isoformat()
    })
    # Keep last 20 actions
    if len(action_memory) > 20:
        action_memory.pop(0)

def get_memory_summary() -> str:
    """Get formatted memory for LLM context"""
    if not action_memory:
        return "No recent actions."
    
    recent = action_memory[-5:]
    return "\n".join([
        f"[{a['timestamp']}] {a['action']}: {str(a['result'])[:80]}"
        for a in recent
    ])

# ==================== LangGraph Tools ====================
# Global client - needed for tools to access it
# (LangGraph tools don't support dependency injection)
# Support both custom and official SDK clients
_client: Optional[Any] = None

def set_client(client: Any):
    """Set global client for tools (supports both custom and official SDK clients)"""
    global _client
    _client = client

@tool
async def get_markets() -> str:
    """Get available prediction markets. Raises exceptions on error."""
    result = await _client.call('a2a.getMarketData', {})
    return json.dumps(result)

@tool
async def get_portfolio() -> str:
    """Get portfolio including balance and positions. Raises exceptions on error."""
    balance = await _client.call('a2a.getBalance', {})
    # Get agent_id - works for both custom and official clients
    agent_id = getattr(_client, 'agent_id', None) or getattr(_client, 'agentId', None)
    positions = await _client.call('a2a.getPositions', {'userId': agent_id} if agent_id else {})
    
    return json.dumps({
        'balance': balance.get('balance', 0),
        'positions': positions
    })

@tool
async def buy_shares(market_id: str, outcome: str, amount: float) -> str:
    """
    Buy YES or NO shares in a prediction market.
    
    Args:
        market_id: Market ID
        outcome: 'YES' or 'NO'
        amount: Amount to invest (must be > 0)
    
    Raises:
        ValidationError: Invalid input
        A2AError: API error
        httpx.HTTPStatusError: Network error
    """
    # Validate inputs - raises ValidationError on invalid
    market_id = validate_market_id(market_id)
    outcome = validate_outcome(outcome)
    amount = validate_amount(amount)
    
    result = await _client.call('a2a.buyShares', {
        'marketId': market_id,
        'outcome': outcome,
        'amount': amount
    })
    
    add_to_memory(f"BUY_{outcome}", result)
    return json.dumps(result)

@tool
async def create_post(content: str) -> str:
    """
    Create a post in Feed feed.
    
    Args:
        content: Post content (max 280 chars)
    
    Raises:
        ValidationError: Invalid content
        A2AError: API error
    """
    content = validate_content(content, max_length=280)
    
    result = await _client.call('a2a.createPost', {
        'content': content,
        'type': 'post'
    })
    
    add_to_memory("CREATE_POST", result)
    return json.dumps(result)

@tool
async def get_feed(limit: int = 20) -> str:
    """Get recent posts from Feed feed."""
    if limit <= 0 or limit > 100:
        raise ValidationError(f"limit must be 1-100, got: {limit}")
    
    result = await _client.call('a2a.getFeed', {
        'limit': limit,
        'offset': 0
    })
    
    return json.dumps(result.get('posts', []))

# ==================== Agent ====================

class FeedAgent:
    """Autonomous Feed trading agent with LangGraph"""
    
    SYSTEM_INSTRUCTION = """You are an autonomous trading agent for Feed prediction markets.

Your capabilities:
- Trade prediction markets (buy YES/NO shares)
- Post insights to the feed
- Analyze markets

Strategy: {strategy}

Guidelines:
- Only trade with strong conviction
- Keep posts under 280 characters
- Be thoughtful and add value

Recent Memory:
{memory}

Your task: Analyze the current state and decide what action to take.
Use the available tools to gather information and execute actions.
"""

    def __init__(self, strategy: str = "balanced"):
        self.strategy = strategy
        self.model = ChatGroq(
            model="llama-3.1-8b-instant",
            api_key=os.getenv('GROQ_API_KEY'),
            temperature=0.7
        )
        
        self.tools = [
            get_markets,
            get_portfolio,
            buy_shares,
            create_post,
            get_feed
        ]
        
        self.graph = create_react_agent(
            self.model,
            tools=self.tools,
            checkpointer=MemorySaver()
        )
    
    def get_system_prompt(self) -> str:
        """Get system prompt with current memory"""
        return self.SYSTEM_INSTRUCTION.format(
            strategy=self.strategy,
            memory=get_memory_summary()
        )
    
    async def decide(self, session_id: str) -> Dict:
        """Make autonomous decision"""
        prompt = f"{self.get_system_prompt()}\n\nAnalyze and decide what action to take."
        
        config = {"configurable": {"thread_id": session_id}}
        result = await self.graph.ainvoke({"messages": [("user", prompt)]}, config)
        
        last_message = result["messages"][-1]
        
        return {
            'decision': last_message.content if hasattr(last_message, 'content') else str(last_message),
            'state': result
        }

# ==================== Logging ====================

class AgentLogger:
    """Comprehensive logger for agent activity"""
    
    def __init__(self, log_file: Optional[str] = None):
        self.log_file = log_file
        self.logs = []
        
    def log(self, level: str, message: str, data: Any = None):
        """Log message with optional data"""
        timestamp = datetime.now().isoformat()
        log_entry = {
            'timestamp': timestamp,
            'level': level,
            'message': message,
            'data': data
        }
        self.logs.append(log_entry)
        
        prefix = {'INFO': '📝', 'SUCCESS': '✅', 'ERROR': '❌', 'WARNING': '⚠️'}.get(level, '•')
        print(f"{prefix} [{timestamp}] {message}")
        
        if self.log_file:
            with open(self.log_file, 'a') as f:
                f.write(json.dumps(log_entry) + '\n')
    
    def info(self, msg: str, data: Any = None): self.log('INFO', msg, data)
    def success(self, msg: str, data: Any = None): self.log('SUCCESS', msg, data)
    def error(self, msg: str, data: Any = None): self.log('ERROR', msg, data)
    def warning(self, msg: str, data: Any = None): self.log('WARNING', msg, data)
    
    def save_summary(self, filename: str):
        """Save summary"""
        with open(filename, 'w') as f:
            json.dump({
                'total_logs': len(self.logs),
                'by_level': {
                    level: len([log for log in self.logs if log['level'] == level])
                    for level in ['INFO', 'SUCCESS', 'ERROR', 'WARNING']
                },
                'logs': self.logs
            }, f, indent=2)

# ==================== Main ====================

async def main(max_ticks: Optional[int] = None, log_file: Optional[str] = None):
    """Main loop"""
    logger = AgentLogger(log_file=log_file)
    client: Optional[Any] = None
    
    try:
        logger.info("Starting Feed Agent")
        if max_ticks:
            logger.info(f"TEST MODE: {max_ticks} ticks")
        
        # Phase 1: Identity
        print("━" * 60)
        print("📝 Phase 1: Agent Identity")
        print("━" * 60)
        
        account = Account.from_key(os.getenv('AGENT0_PRIVATE_KEY'))
        token_id = int(time.time()) % 100000
        
        identity = {
            'tokenId': token_id,
            'address': account.address,
            'agentId': f"11155111:{token_id}",
            'name': os.getenv('AGENT_NAME', 'Python Agent')
        }
        
        logger.success("Identity Ready", identity)
        print("")
        
        # Phase 2: Connect
        print("━" * 60)
        print("🔌 Phase 2: Connect to Feed")
        print("━" * 60)
        
        # Use official SDK (required for 100% compliance)
        try:
            from feed_a2a_client import FeedA2AClient
            feed_url = os.getenv('FEED_URL', 'http://localhost:3000')
            agent_card_url = f"{feed_url}/.well-known/agent-card.json"
            
            client = FeedA2AClient(
                agent_card_url=agent_card_url,
                agent_id=identity['agentId'],
                address=identity['address'],
                token_id=identity['tokenId']
            )
            await client.connect()
            
            logger.success("Connected via A2A SDK", {
                'agent_card_url': agent_card_url,
                'agent_id': identity['agentId']
            })
            print("")
        except ImportError as e:
            logger.error("A2A SDK required for compliance", {
                'error': str(e),
                'hint': 'Install: pip install a2a-sdk'
            })
            raise ImportError(
                "A2A SDK (a2a-sdk) is required. "
                "Install with: pip install a2a-sdk"
            ) from e
        except Exception as e:
            logger.error("Failed to connect via A2A SDK", {
                'error': str(e)
            })
            raise
        
        set_client(client)  # Set global for tools
        print("")
        
        # Phase 3: LangGraph
        print("━" * 60)
        print("🧠 Phase 3: LangGraph Agent")
        print("━" * 60)
        
        strategy = os.getenv('AGENT_STRATEGY', 'balanced')
        agent = FeedAgent(strategy=strategy)
        
        logger.success("Agent Ready", {'strategy': strategy, 'tools': len(agent.tools)})
        print("")
        
        # Phase 4: Loop
        print("━" * 60)
        print("🔄 Phase 4: Autonomous Loop")
        print("━" * 60)
        
        tick_interval = int(os.getenv('TICK_INTERVAL', '30'))
        tick_count = 0
        tick_start_time = time.time()
        
        while True:
            tick_count += 1
            
            if max_ticks and tick_count > max_ticks:
                logger.success(f"Completed {max_ticks} ticks")
                break
            
            print(f"\n━━━ TICK #{tick_count}" + (f" / {max_ticks}" if max_ticks else "") + " ━━━")
            
            tick_start = time.time()
            logger.info(f"Starting tick #{tick_count}")
            
            try:
                result = await agent.decide(session_id=identity['agentId'])
                tick_duration = time.time() - tick_start
                
                logger.success(f"Tick #{tick_count} complete", {
                    'duration_seconds': round(tick_duration, 2),
                    'decision_preview': result['decision'][:100]
                })
                
            except Exception as e:
                logger.error(f"Tick #{tick_count} error: {type(e).__name__}: {e}")
                # Continue to next tick instead of crashing
                if not max_ticks:  # Only continue in production mode
                    continue
                raise  # Re-raise in test mode to see errors
            
            # Sleep
            if not max_ticks or tick_count < max_ticks:
                logger.info(f"Sleeping {tick_interval}s...")
                await asyncio.sleep(tick_interval)
        
        # Summary
        if max_ticks:
            total_duration = time.time() - tick_start_time
            print("\n" + "=" * 60)
            print("🎉 TEST COMPLETE")
            print("=" * 60)
            logger.success("Test complete", {
                'total_ticks': tick_count,
                'total_duration_seconds': round(total_duration, 2)
            })
            
            if log_file:
                summary_file = log_file.replace('.jsonl', '_summary.json')
                logger.save_summary(summary_file)
                logger.info(f"Logs: {log_file}, Summary: {summary_file}")
    
    except KeyboardInterrupt:
        logger.warning("Interrupted by user")
    
    finally:
        if client:
            await client.close()
            logger.info("Client closed")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Feed Autonomous Agent')
    parser.add_argument('--test', action='store_true', help='Run for 10 ticks')
    parser.add_argument('--ticks', type=int, help='Run for N ticks')
    parser.add_argument('--log', type=str, help='Log file (JSONL)')
    
    args = parser.parse_args()
    
    max_ticks = 10 if args.test else args.ticks
    
    asyncio.run(main(max_ticks=max_ticks, log_file=args.log))
