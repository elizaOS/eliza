"""
Test client for elizaOS A2A Server
"""

from __future__ import annotations

import asyncio
import os
import httpx


BASE_URL = os.environ.get("A2A_URL", "http://localhost:3000")


async def run_a2a_test_client(base_url: str) -> None:
    print("🧪 Testing elizaOS A2A Server\n")
    print(f"   URL: {base_url}\n")

    async with httpx.AsyncClient() as client:
        # Test 1: Get agent info
        print("ℹ️  Getting agent info...")
        info_response = await client.get(f"{base_url}/")
        info = info_response.json()
        print(f"   Name: {info['name']}")
        print(f"   Bio: {info['bio']}")
        print(f"   Agent ID: {info['agentId']}")
        print(f"   Capabilities: {', '.join(info['capabilities'])}")
        print()

        # Test 2: Health check
        print("🏥 Health check...")
        health_response = await client.get(f"{base_url}/health")
        health = health_response.json()
        print(f"   Status: {health['status']}")
        print()

        # Test 3: Chat with agent
        print("💬 Testing chat...")
        session_id = f"test-session-{int(asyncio.get_event_loop().time())}"

        test_messages = [
            "Hello! I'm another AI agent. What's your name?",
            "Can you help me understand how to integrate with other systems?",
            "Thank you for your help!",
        ]

        for message in test_messages:
            print(f"   User: {message}")

            chat_response = await client.post(
                f"{base_url}/chat",
                json={"message": message, "sessionId": session_id},
                headers={"X-Agent-Id": "test-agent-001"},
            )

            chat = chat_response.json()
            print(f"   Agent: {chat['response']}")
            print(f"   Session: {chat['sessionId']}")
            print()

        # Test 4: Streaming
        print("📡 Testing streaming...")
        print("   User: Count from 1 to 5")
        print("   Agent: ", end="", flush=True)

        async with client.stream(
            "POST",
            f"{base_url}/chat/stream",
            json={
                "message": "Count from 1 to 5, one number per line",
                "sessionId": session_id,
            },
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    import json
                    try:
                        data = json.loads(line[6:])
                        if "text" in data:
                            print(data["text"], end="", flush=True)
                    except json.JSONDecodeError:
                        pass

        print("\n")
        print("✅ All tests passed!")


if __name__ == "__main__":
    asyncio.run(run_a2a_test_client(BASE_URL))

