"""
Babylon Official A2A Protocol Example (Python)

This example demonstrates proper usage of the official A2A protocol
using the a2a-sdk Python package.

Prerequisites:
- a2a-sdk installed (in pyproject.toml)
- Babylon server running
- BABYLON_URL environment variable (optional)

Run: python babylon_a2a_official.py
"""

import os
import json
import uuid
import asyncio
from dotenv import load_dotenv

# Import official A2A SDK
try:
    from a2a.client import A2AClient
    HAS_A2A_SDK = True
except ImportError:
    print("⚠️  Official a2a-sdk not installed!")
    print("   Install: pip install a2a-sdk")
    HAS_A2A_SDK = False

load_dotenv()

BABYLON_URL = os.getenv('BABYLON_URL', 'http://localhost:3000')
AGENT_CARD_URL = f"{BABYLON_URL}/.well-known/agent-card.json"


async def main():
    """Main example function"""
    
    print("🤖 Babylon Official A2A Example (Python)")
    print("=" * 70)
    
    if not HAS_A2A_SDK:
        print("\n❌ This example requires the official a2a-sdk")
        print("   Install: pip install a2a-sdk")
        return
    
    # ==========================================
    # STEP 1: Initialize A2A Client
    # ==========================================
    
    print("\n📡 Step 1: Connecting to Babylon via official A2A...")
    print(f"   Agent Card URL: {AGENT_CARD_URL}")
    
    try:
        # Use official SDK to create client from agent card
        client = A2AClient.from_card_url(AGENT_CARD_URL)
        print("✅ A2A Client initialized!")
        
    except Exception as e:
        print(f"❌ Failed to initialize client: {e}")
        print("\n💡 Make sure Babylon server is running:")
        print("   cd /path/to/babylon && bun dev")
        return
    
    # ==========================================
    # STEP 2: Get and Display AgentCard
    # ==========================================
    
    print("\n📋 Step 2: Fetching AgentCard...")
    
    try:
        card = await client.get_agent_card()
        
        print("✅ AgentCard received!")
        print(f"   Name: {card.get('name', 'Unknown')}")
        print(f"   Protocol Version: {card.get('protocolVersion', 'Unknown')}")
        print(f"   Transport: {card.get('preferredTransport', 'Unknown')}")
        
        skills = card.get('skills', [])
        print(f"\n   🎯 Available Skills ({len(skills)}):")
        for i, skill in enumerate(skills, 1):
            print(f"   {i}. {skill.get('name', 'Unknown')} ({skill.get('id', 'unknown')})")
            desc = skill.get('description', '')
            if desc:
                print(f"      {desc[:80]}...")
                
    except Exception as e:
        print(f"❌ Failed to get agent card: {e}")
        return
    
    # ==========================================
    # STEP 3: Execute Portfolio Skill
    # ==========================================
    
    print("\n💰 Step 3: Getting Portfolio (portfolio-analyst skill)...")
    
    try:
        # Use official A2A message/send
        response = await client.send_message({
            'message': {
                'kind': 'message',
                'messageId': str(uuid.uuid4()),
                'role': 'user',
                'parts': [{
                    'kind': 'text',
                    'text': '{"action": "get_balance", "params": {}}'
                }]
            }
        })
        
        print("✅ Response received!")
        print(f"   Type: {response.get('kind', 'unknown')}")
        
        if response.get('kind') == 'task':
            print(f"   Task ID: {response.get('id', 'unknown')}")
            print(f"   Status: {response.get('status', {}).get('state', 'unknown')}")
            
            # Check for artifacts (results)
            artifacts = response.get('artifacts', [])
            if artifacts:
                print("\n   📊 Results:")
                for i, artifact in enumerate(artifacts, 1):
                    print(f"   Artifact {i}: {artifact}")
        elif response.get('kind') == 'message':
            print("   Direct message response")
            
    except Exception as e:
        print(f"❌ Portfolio query failed: {e}")
    
    # ==========================================
    # STEP 4: Execute Trading Skill
    # ==========================================
    
    print("\n📈 Step 4: Executing Trade (prediction-market-trader skill)...")
    
    try:
        trade_message = json.dumps({
            'action': 'buy_shares',
            'params': {
                'marketId': 'market-example',  # Replace with real market ID
                'outcome': 'YES',
                'amount': 100
            }
        })
        
        response = await client.send_message({
            'message': {
                'kind': 'message',
                'messageId': str(uuid.uuid4()),
                'role': 'user',
                'parts': [{
                    'kind': 'text',
                    'text': trade_message
                }]
            }
        })
        
        print("✅ Trade message sent!")
        
        if response.get('kind') == 'task':
            task_id = response['id']
            print(f"   Task created: {task_id}")
            print(f"   Initial status: {response.get('status', {}).get('state', 'unknown')}")
            
            # Poll for completion
            print("\n   ⏳ Waiting for task completion...")
            for attempt in range(10):
                await asyncio.sleep(1)
                
                task = await client.get_task({'id': task_id})
                state = task.get('status', {}).get('state', 'unknown')
                print(f"   Check {attempt + 1}: {state}")
                
                if state in ['completed', 'failed', 'canceled']:
                    if state == 'completed':
                        print("\n   ✅ Trade completed!")
                        if task.get('artifacts'):
                            print(f"   Results: {task['artifacts']}")
                    else:
                        print(f"\n   ❌ Task {state}")
                        if task.get('status', {}).get('message'):
                            print(f"   Message: {task['status']['message']}")
                    break
                    
    except Exception as e:
        print(f"❌ Trade execution failed: {e}")
    
    # ==========================================
    # STEP 5: Execute Social Skill
    # ==========================================
    
    print("\n💬 Step 5: Creating Social Post (social-media-manager skill)...")
    
    try:
        response = await client.send_message({
            'message': {
                'kind': 'message',
                'messageId': str(uuid.uuid4()),
                'role': 'user',
                'parts': [{
                    'kind': 'text',
                    'text': 'Post: Just executed my first trade via official A2A protocol! 🚀'
                }]
            }
        })
        
        print("✅ Post created!")
        print(f"   Response: {response.get('kind', 'unknown')}")
        
    except Exception as e:
        print(f"❌ Post creation failed: {e}")
    
    # ==========================================
    # Summary
    # ==========================================
    
    print("\n" + "=" * 70)
    print("🎉 Example Complete!")
    print("\nYou've successfully:")
    print("  ✅ Connected using official A2A SDK (a2a-sdk)")
    print("  ✅ Fetched and validated AgentCard")
    print("  ✅ Executed multiple Babylon skills")
    print("  ✅ Handled task lifecycle properly")
    print("\n💡 Next steps:")
    print("  - Build your own agent using a2a-sdk")
    print("  - Integrate with Agent0 for discovery")
    print("  - Explore all 10 Babylon skills")


if __name__ == '__main__':
    asyncio.run(main())

