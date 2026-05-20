"""
Babylon Agent - DEBUGGING VERSION
Fully instrumented version that logs EVERY input/output to verify data flow.

Use this for:
- Debugging A2A protocol issues
- Verifying tool calls and responses
- Understanding agent decision flow
- Development and testing

For production, use agent.py instead.
"""

import os
import json
import time
import asyncio
import argparse
from datetime import datetime
from typing import Any, Dict, Optional
from dotenv import load_dotenv

from langchain_groq import ChatGroq
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

import httpx
from eth_account import Account

load_dotenv()

# ==================== Exceptions ====================

class A2AError(Exception):
    """A2A protocol error"""
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"A2A Error [{code}]: {message}")

# ==================== Instrumented Client ====================

class InstrumentedA2AClient:
    """HTTP client with FULL logging of every request/response"""
    
    def __init__(self, http_url: str, address: str, token_id: int, chain_id: int = 11155111):
        self.http_url = http_url
        self.address = address
        self.token_id = token_id
        self.chain_id = chain_id
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
        self.message_id = 1
        self.agent_id = f"{chain_id}:{token_id}"
        self.call_log = []
        
    async def call(self, method: str, params: Optional[Dict] = None) -> Dict:
        """Make JSON-RPC call with full logging"""
        request_id = self.message_id
        self.message_id += 1
        
        # Build request
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
        
        # LOG REQUEST
        print(f"\n{'='*80}")
        print(f"📤 A2A REQUEST #{request_id}")
        print(f"{'='*80}")
        print(f"Method: {method}")
        print(f"Params: {json.dumps(params, indent=2)}")
        print(f"Headers: {json.dumps(headers, indent=2)}")
        print(f"URL: {self.http_url}")
        
        start_time = time.time()
        
        # Make request
        response = await self.client.post(self.http_url, json=message, headers=headers)
        
        duration = time.time() - start_time
        
        # LOG RESPONSE
        print(f"\n📥 A2A RESPONSE #{request_id} ({duration:.3f}s)")
        print(f"Status: {response.status_code}")
        
        result = response.json()
        
        print(f"Response: {json.dumps(result, indent=2)}")
        
        # Log to history
        self.call_log.append({
            'timestamp': datetime.now().isoformat(),
            'request_id': request_id,
            'method': method,
            'params': params,
            'status_code': response.status_code,
            'response': result,
            'duration_seconds': duration
        })
        
        # Handle errors
        if response.status_code >= 400:
            print(f"❌ HTTP Error: {response.status_code}")
            response.raise_for_status()
        
        if 'error' in result:
            error = result['error']
            print(f"❌ A2A Error: [{error.get('code')}] {error.get('message')}")
            raise A2AError(
                code=error.get('code', -1),
                message=error.get('message', 'Unknown error'),
                data=error.get('data')
            )
        
        print("✅ Success")
        print(f"{'='*80}\n")
            
        return result['result']
    
    async def close(self):
        """Close client"""
        await self.client.aclose()
    
    def save_call_log(self, filename: str):
        """Save all API calls to file"""
        with open(filename, 'w') as f:
            json.dump({
                'total_calls': len(self.call_log),
                'agent_id': self.agent_id,
                'calls': self.call_log
            }, f, indent=2)

# ==================== Instrumented Tools ====================

_client: Optional[InstrumentedA2AClient] = None

def set_client(client: InstrumentedA2AClient):
    global _client
    _client = client

@tool
async def get_markets() -> str:
    """Get available prediction markets"""
    print("\n🔧 TOOL CALLED: get_markets()")
    result = await _client.call('a2a.getMarketData', {})
    print(f"🔧 TOOL RESULT: {json.dumps(result, indent=2)[:200]}...")
    return json.dumps(result)

@tool
async def get_portfolio() -> str:
    """Get portfolio (balance + positions)"""
    print("\n🔧 TOOL CALLED: get_portfolio()")
    
    print("  → Calling a2a.getBalance...")
    balance = await _client.call('a2a.getBalance', {})
    
    print("  → Calling a2a.getPositions...")
    positions = await _client.call('a2a.getPositions', {'userId': _client.agent_id})
    
    result = {
        'balance': balance.get('balance', 0),
        'positions': positions
    }
    
    print(f"🔧 TOOL RESULT: {json.dumps(result, indent=2)}")
    return json.dumps(result)

@tool
async def get_feed(limit: int = 20) -> str:
    """Get recent feed posts"""
    print(f"\n🔧 TOOL CALLED: get_feed(limit={limit})")
    
    result = await _client.call('a2a.getFeed', {
        'limit': limit,
        'offset': 0
    })
    
    print(f"🔧 TOOL RESULT: {len(result.get('posts', []))} posts")
    return json.dumps(result.get('posts', []))

# ==================== Instrumented Agent ====================

class InstrumentedAgent:
    """LangGraph agent with full I/O logging"""
    
    SYSTEM_INSTRUCTION = """You are a trading agent for Babylon.

Available tools:
- get_markets() - Get available markets
- get_portfolio() - Get your balance and positions
- get_feed(limit) - Get recent posts

Strategy: {strategy}

Task: Use tools to gather information, then analyze and decide.
"""

    def __init__(self, strategy: str = "balanced"):
        self.strategy = strategy
        self.model = ChatGroq(
            model="llama-3.1-8b-instant",
            api_key=os.getenv('GROQ_API_KEY'),
            temperature=0.7
        )
        
        self.tools = [get_markets, get_portfolio, get_feed]
        self.graph = create_react_agent(self.model, tools=self.tools, checkpointer=MemorySaver())
        self.invocation_log = []
    
    def get_system_prompt(self) -> str:
        return self.SYSTEM_INSTRUCTION.format(strategy=self.strategy)
    
    async def decide(self, session_id: str) -> Dict:
        """Make decision with full logging"""
        prompt = f"{self.get_system_prompt()}\n\nGather information using tools and analyze."
        
        print(f"\n{'='*80}")
        print("🧠 LLM INVOCATION")
        print(f"{'='*80}")
        print(f"Prompt (first 300 chars):\n{prompt[:300]}...")
        print(f"Session ID: {session_id}")
        
        config = {"configurable": {"thread_id": session_id}}
        
        start_time = time.time()
        result = await self.graph.ainvoke({"messages": [("user", prompt)]}, config)
        duration = time.time() - start_time
        
        print(f"\n📊 LLM RESPONSE ({duration:.2f}s)")
        print(f"Messages in response: {len(result.get('messages', []))}")
        
        # Log all messages
        for i, msg in enumerate(result.get('messages', [])):
            msg_type = type(msg).__name__
            content = getattr(msg, 'content', str(msg))
            tool_calls = getattr(msg, 'tool_calls', [])
            
            print(f"\n  Message {i+1} ({msg_type}):")
            print(f"    Content: {content[:200]}...")
            if tool_calls:
                print(f"    Tool calls: {len(tool_calls)}")
                for tc in tool_calls:
                    print(f"      - {tc.get('name', 'unknown')}({tc.get('args', {})})")
        
        last_message = result["messages"][-1]
        decision = last_message.content if hasattr(last_message, 'content') else str(last_message)
        
        print("\n💡 FINAL DECISION:")
        print(f"{decision}")
        print(f"{'='*80}\n")
        
        # Log invocation
        self.invocation_log.append({
            'timestamp': datetime.now().isoformat(),
            'session_id': session_id,
            'duration_seconds': duration,
            'message_count': len(result.get('messages', [])),
            'decision': decision
        })
        
        return {'decision': decision, 'state': result}
    
    def save_invocation_log(self, filename: str):
        """Save LLM invocation log"""
        with open(filename, 'w') as f:
            json.dump({
                'total_invocations': len(self.invocation_log),
                'invocations': self.invocation_log
            }, f, indent=2)

# ==================== Main ====================

async def main(max_ticks: Optional[int] = None):
    """Main loop with full instrumentation"""
    client: Optional[InstrumentedA2AClient] = None
    agent: Optional[InstrumentedAgent] = None
    
    try:
        print("\n" + "="*80)
        print("🔬 FULLY INSTRUMENTED BABYLON AGENT")
        print("="*80)
        print("Logs EVERY input/output to verify data flow\n")
        
        if max_ticks:
            print(f"🧪 TEST MODE: {max_ticks} ticks\n")
        
        # Phase 1: Identity
        print("━" * 80)
        print("📝 Phase 1: Agent Identity")
        print("━" * 80)
        
        private_key = os.getenv('AGENT0_PRIVATE_KEY')
        print(f"Private key: {private_key[:10]}...{private_key[-4:]}")
        
        account = Account.from_key(private_key)
        print(f"Derived address: {account.address}")
        
        token_id = int(time.time()) % 100000
        print(f"Generated token ID: {token_id}")
        
        identity = {
            'tokenId': token_id,
            'address': account.address,
            'agentId': f"11155111:{token_id}",
            'name': os.getenv('AGENT_NAME', 'Instrumented Agent')
        }
        
        print(f"✅ Agent ID: {identity['agentId']}\n")
        
        # Phase 2: Connect
        print("━" * 80)
        print("🔌 Phase 2: Connect to Babylon")
        print("━" * 80)
        
        a2a_url = os.getenv('BABYLON_A2A_URL', 'http://localhost:3000/api/a2a')
        print(f"A2A URL: {a2a_url}")
        
        client = InstrumentedA2AClient(
            http_url=a2a_url,
            address=identity['address'],
            token_id=identity['tokenId']
        )
        
        set_client(client)
        print("✅ Client created\n")
        
        # Phase 3: LangGraph
        print("━" * 80)
        print("🧠 Phase 3: LangGraph Agent")
        print("━" * 80)
        
        strategy = os.getenv('AGENT_STRATEGY', 'balanced')
        print(f"Strategy: {strategy}")
        print("Model: llama-3.1-8b-instant")
        
        agent = InstrumentedAgent(strategy=strategy)
        print(f"Tools: {len(agent.tools)}")
        for t in agent.tools:
            print(f"  - {t.name}: {t.description}")
        
        print("✅ Agent ready\n")
        
        # Phase 4: Loop
        print("━" * 80)
        print("🔄 Phase 4: Autonomous Loop")
        print("━" * 80)
        
        tick_interval = int(os.getenv('TICK_INTERVAL', '10'))
        print(f"Tick interval: {tick_interval}s")
        
        tick_count = 0
        
        while True:
            tick_count += 1
            
            if max_ticks and tick_count > max_ticks:
                break
            
            print(f"\n{'#'*80}")
            print(f"# TICK {tick_count}" + (f" / {max_ticks}" if max_ticks else ""))
            print(f"{'#'*80}\n")
            
            await agent.decide(session_id=identity['agentId'])
            
            print(f"✅ Tick {tick_count} complete\n")
            
            if not max_ticks or tick_count < max_ticks:
                print(f"⏳ Sleeping {tick_interval}s...\n")
                await asyncio.sleep(tick_interval)
        
        # Save logs
        if max_ticks:
            print("\n" + "="*80)
            print("📊 SAVING LOGS")
            print("="*80)
            
            api_log_file = 'instrumented_api_calls.json'
            llm_log_file = 'instrumented_llm_calls.json'
            
            client.save_call_log(api_log_file)
            agent.save_invocation_log(llm_log_file)
            
            print(f"✅ API calls saved to: {api_log_file}")
            print(f"✅ LLM calls saved to: {llm_log_file}")
            
            print("\n📈 SUMMARY:")
            print(f"  Total API calls: {len(client.call_log)}")
            print(f"  Total LLM calls: {len(agent.invocation_log)}")
            print(f"  Total ticks: {tick_count}")
            
    except KeyboardInterrupt:
        print("\n⚠️  Interrupted")
    
    finally:
        if client:
            await client.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Instrumented Babylon Agent')
    parser.add_argument('--ticks', type=int, default=2, help='Number of ticks (default: 2)')
    
    args = parser.parse_args()
    
    asyncio.run(main(max_ticks=args.ticks))

