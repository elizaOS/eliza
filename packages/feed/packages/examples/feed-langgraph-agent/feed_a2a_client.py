"""
Feed A2A Client Wrapper

This wrapper uses the a2a-sdk Python package and implements
all Feed methods via the A2A protocol (message/send).

Fully compliant with A2A specification.
"""

import json
import uuid
import logging
import asyncio
import httpx
from typing import Any, Dict, Optional
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Import official A2A SDK
try:
    from a2a.client import A2AClient
    from a2a.types import Message
    HAS_A2A_SDK = True
except ImportError:
    HAS_A2A_SDK = False
    print("⚠️  Official a2a-sdk not installed!")
    print("   Install: pip install a2a-sdk")

load_dotenv()


class A2AError(Exception):
    """A2A protocol error"""
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"A2A Error [{code}]: {message}")


class FeedA2AClient:
    """
    A2A SDK wrapper for Feed
    
    Uses message/send for all operations, fully compliant with A2A spec.
    Provides convenience methods that map to Feed skills.
    """
    
    def __init__(self, agent_card_url: str, agent_id: str, address: str, token_id: int):
        """
        Initialize client with a2a-sdk
        
        Args:
            agent_card_url: URL to Feed's agent card (/.well-known/agent-card.json)
            agent_id: Agent identifier (format: "chainId:tokenId")
            address: Agent wallet address
            token_id: Agent token ID
        """
        if not HAS_A2A_SDK:
            raise ImportError("a2a-sdk is required. Install: pip install a2a-sdk")
        
        self.agent_card_url = agent_card_url
        self.agent_id = agent_id
        self.agentId = agent_id  # Alias for compatibility
        self.address = address
        self.token_id = token_id
        self.client: Optional[A2AClient] = None
        self.agent_card: Optional[Dict[str, Any]] = None
        self.endpoint_url: str = ''
        self._initialized = False
    
    async def connect(self):
        """Initialize A2A client from agent card with authentication"""
        if self._initialized:
            return
        
        # Fetch agent card to get endpoint URL
        async with httpx.AsyncClient(timeout=30.0) as client:
            card_response = await client.get(self.agent_card_url)
            card_response.raise_for_status()
            self.agent_card = card_response.json()
        
        # Extract endpoint URL from agent card
        self.endpoint_url = self.agent_card.get('url', '').replace('/api/a2a', '') + '/api/a2a'
        if not self.endpoint_url.startswith('http'):
            # Fallback: construct from agent_card_url
            base_url = self.agent_card_url.replace('/.well-known/agent-card.json', '')
            self.endpoint_url = f"{base_url}/api/a2a"
        
        # Initialize SDK client for type checking and structure validation
        # But we'll make direct HTTP calls with auth headers for actual requests
        try:
            self.client = await A2AClient.from_card_url(self.agent_card_url)
        except Exception as e:
            logger.warning(f"Could not initialize SDK client, will use direct HTTP: {e}")
            self.client = None
        
        self._initialized = True
    
    async def _send_message(self, text: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Send message via official A2A protocol using direct HTTP with auth headers
        
        This ensures 100% compliance by using official message/send method
        with proper authentication headers.
        
        Args:
            text: Message text (can be JSON string for structured actions)
            data: Optional structured data
            
        Returns:
            Task or Message response
        """
        if not self._initialized:
            await self.connect()
        
        parts = [{'kind': 'text', 'text': text}]
        if data:
            parts.append({'kind': 'data', 'data': data})
        
        message: Message = {
            'kind': 'message',
            'messageId': str(uuid.uuid4()),
            'role': 'user',
            'parts': parts,
            'contextId': self.agent_id
        }
        
        # Make direct HTTP call to official A2A endpoint with auth headers
        # This ensures 100% compliance with A2A protocol
        async with httpx.AsyncClient(timeout=30.0) as client:
            http_response = await client.post(
                self.endpoint_url,
                headers={
                    'Content-Type': 'application/json',
                    'x-agent-id': self.agent_id,
                    'x-agent-address': self.address,
                    'x-agent-token-id': str(self.token_id)
                },
                json={
                    'jsonrpc': '2.0',
                    'method': 'message/send',
                    'params': {'message': message},
                    'id': 1
                }
            )
            http_response.raise_for_status()
            response = http_response.json()
        
        # Handle error response
        if 'error' in response:
            error = response['error']
            raise A2AError(
                code=error.get('code', -1),
                message=error.get('message', 'Unknown error'),
                data=error.get('data')
            )
        
        result = response.get('result', response)
        
        # If it's a task, wait for completion and return result
        if isinstance(result, dict) and result.get('kind') == 'task':
            task = result
            task_id = task['id']
            
            # Poll for completion using tasks/get
            max_attempts = 30
            for attempt in range(max_attempts):
                await asyncio.sleep(0.5)
                
                # Use direct HTTP call for tasks/get as well
                async with httpx.AsyncClient(timeout=30.0) as client:
                    task_http_response = await client.post(
                        self.endpoint_url,
                        headers={
                            'Content-Type': 'application/json',
                            'x-agent-id': self.agent_id,
                            'x-agent-address': self.address,
                            'x-agent-token-id': str(self.token_id)
                        },
                        json={
                            'jsonrpc': '2.0',
                            'method': 'tasks/get',
                            'params': {'id': task_id},
                            'id': 2
                        }
                    )
                    task_http_response.raise_for_status()
                    task_response = task_http_response.json()
                
                if 'error' in task_response:
                    raise A2AError(
                        code=task_response['error'].get('code', -1),
                        message=task_response['error'].get('message', 'Unknown error')
                    )
                
                task = task_response.get('result', task_response)
                state = task.get('status', {}).get('state', 'unknown')
                
                if state in ['completed', 'failed', 'canceled']:
                    if state == 'completed':
                        # Extract artifacts as result
                        artifacts = task.get('artifacts', [])
                        if artifacts:
                            # Return first artifact's data
                            first_artifact = artifacts[0]
                            parts = first_artifact.get('parts', [])
                            for part in parts:
                                if part.get('kind') == 'data':
                                    return part.get('data', {})
                                elif part.get('kind') == 'text':
                                    # Try to parse as JSON
                                    try:
                                        return json.loads(part.get('text', '{}'))
                                    except Exception:
                                        return {'text': part.get('text', '')}
                        return task
                    else:
                        error_msg = task.get('status', {}).get('message', f'Task {state}')
                        raise A2AError(code=-1, message=error_msg)
            
            # Timeout
            raise A2AError(code=-1, message='Task timeout')
        
        # Direct message response
        return result
    
    async def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Call Feed method via official A2A protocol
        
        This method converts Feed's custom methods (a2a.*) to official
        A2A message/send calls. For full compliance, use _send_message directly.
        
        Args:
            method: Method name (e.g., 'a2a.getBalance')
            params: Method parameters
            
        Returns:
            Method result
        """
        # Remove 'a2a.' prefix
        method_name = method.replace('a2a.', '')
        
        # Map camelCase method names to snake_case action names expected by executor
        # This matches the exact action names in feed-executor.ts
        method_to_action = {
            # Trading
            'buyShares': 'buy_shares',
            'sellShares': 'sell_shares',
            'openPosition': 'open_position',
            'closePosition': 'close_position',
            'getPredictions': 'get_predictions',
            'getPerpetuals': 'get_perpetuals',
            'getTrades': 'get_trades',
            'getTradeHistory': 'get_trade_history',
            'getMarketData': 'get_predictions',  # Alias
            # Social
            'getFeed': 'get_feed',
            'getPost': 'get_post',
            'createPost': 'create_post',
            'deletePost': 'delete_post',
            'likePost': 'like_post',
            'unlikePost': 'unlike_post',
            'sharePost': 'share_post',
            'getComments': 'get_comments',
            'createComment': 'create_comment',
            'deleteComment': 'delete_comment',
            'likeComment': 'like_comment',
            # Messaging
            'getChats': 'get_chats',
            'getChatMessages': 'get_chat_messages',
            'sendMessage': 'send_message',
            'createGroup': 'create_group',
            'leaveChat': 'leave_chat',
            'getUnreadCount': 'get_unread_count',
            # Users
            'getUserProfile': 'get_user_profile',
            'updateProfile': 'update_profile',
            'followUser': 'follow_user',
            'unfollowUser': 'unfollow_user',
            'getFollowers': 'get_followers',
            'getFollowing': 'get_following',
            'searchUsers': 'search_users',
            # Notifications
            'getNotifications': 'get_notifications',
            'markNotificationsRead': 'mark_notifications_read',
            'getGroupInvites': 'get_group_invites',
            'acceptGroupInvite': 'accept_group_invite',
            'declineGroupInvite': 'decline_group_invite',
            # Stats
            'getLeaderboard': 'get_leaderboard',
            'getUserStats': 'get_user_stats',
            'getSystemStats': 'get_system_stats',
            'getReferrals': 'get_referrals',
            'getReferralStats': 'get_referral_stats',
            'getReferralCode': 'get_referral_code',
            'getReputation': 'get_reputation',
            'getReputationBreakdown': 'get_reputation_breakdown',
            'getTrendingTags': 'get_trending_tags',
            'getPostsByTag': 'get_posts_by_tag',
            'getOrganizations': 'get_organizations',
            # Portfolio
            'getBalance': 'get_balance',
            'getPositions': 'get_positions',
            # Favorites
            'favoriteProfile': 'favorite_profile',
            'unfavoriteProfile': 'unfavorite_profile',
            'getFavorites': 'get_favorites',
            'getFavoritePosts': 'get_favorite_posts',
            # Moderation
            'blockUser': 'block_user',
            'unblockUser': 'unblock_user',
            'muteUser': 'mute_user',
            'unmuteUser': 'unmute_user',
            'reportUser': 'report_user',
            'reportPost': 'report_post',
            'getBlocks': 'get_blocks',
            'getMutes': 'get_mutes',
            'checkBlockStatus': 'check_block_status',
            'checkMuteStatus': 'check_mute_status',
        }
        
        # Convert camelCase to snake_case if not in mapping
        if method_name not in method_to_action:
            # Fallback: convert camelCase to snake_case
            import re
            action = re.sub(r'(?<!^)(?=[A-Z])', '_', method_name).lower()
        else:
            action = method_to_action[method_name]
        
        # Build structured message
        message_data = {
            'action': action,
            'params': params or {}
        }
        
        message_text = json.dumps(message_data)
        
        return await self._send_message(message_text)
    
    # ===== Convenience Methods (using official protocol) =====
    
    async def get_balance(self) -> Dict[str, Any]:
        """Get agent balance"""
        return await self.call('a2a.getBalance', {})
    
    async def get_positions(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Get agent positions"""
        return await self.call('a2a.getPositions', {'userId': user_id} if user_id else {})
    
    async def get_predictions(self, user_id: Optional[str] = None, status: Optional[str] = None) -> Dict[str, Any]:
        """Get prediction markets"""
        params = {}
        if user_id:
            params['userId'] = user_id
        if status:
            params['status'] = status
        return await self.call('a2a.getPredictions', params)
    
    async def get_perpetuals(self) -> Dict[str, Any]:
        """Get perpetual markets"""
        return await self.call('a2a.getPerpetuals', {})
    
    async def buy_shares(self, market_id: str, outcome: str, amount: float) -> Dict[str, Any]:
        """Buy prediction market shares"""
        return await self.call('a2a.buyShares', {
            'marketId': market_id,
            'outcome': outcome,
            'amount': amount
        })
    
    async def sell_shares(self, position_id: str, shares: float) -> Dict[str, Any]:
        """Sell prediction market shares"""
        return await self.call('a2a.sellShares', {
            'positionId': position_id,
            'shares': shares
        })
    
    async def open_position(self, ticker: str, side: str, amount: float, leverage: int) -> Dict[str, Any]:
        """Open perpetual position"""
        return await self.call('a2a.openPosition', {
            'ticker': ticker,
            'side': side,
            'amount': amount,
            'leverage': leverage
        })
    
    async def close_position(self, position_id: str) -> Dict[str, Any]:
        """Close perpetual position"""
        return await self.call('a2a.closePosition', {'positionId': position_id})
    
    async def get_feed(self, limit: int = 20, offset: int = 0) -> Dict[str, Any]:
        """Get social feed"""
        return await self.call('a2a.getFeed', {'limit': limit, 'offset': offset})
    
    async def create_post(self, content: str, post_type: str = 'post') -> Dict[str, Any]:
        """Create social post"""
        return await self.call('a2a.createPost', {
            'content': content,
            'type': post_type
        })
    
    async def get_chats(self, filter_type: Optional[str] = None) -> Dict[str, Any]:
        """Get chats"""
        params = {}
        if filter_type:
            params['filter'] = filter_type
        return await self.call('a2a.getChats', params)
    
    async def send_message(self, chat_id: str, content: str) -> Dict[str, Any]:
        """Send chat message"""
        return await self.call('a2a.sendMessage', {
            'chatId': chat_id,
            'content': content
        })
    
    async def get_notifications(self, limit: int = 20) -> Dict[str, Any]:
        """Get notifications"""
        return await self.call('a2a.getNotifications', {'limit': limit})


