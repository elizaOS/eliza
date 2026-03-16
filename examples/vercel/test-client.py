#!/usr/bin/env python3
"""
Test client for elizaOS Vercel Edge Functions

Usage:
    python3 test-client.py                                    # Test local
    python3 test-client.py --endpoint https://your-app.vercel.app  # Test deployed

Environment:
    VERCEL_URL - Base URL for the Vercel deployment
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from typing import TypedDict


class ChatResponse(TypedDict):
    response: str
    conversationId: str
    timestamp: str


class HealthResponse(TypedDict):
    status: str
    runtime: str
    version: str


class ErrorResponse(TypedDict):
    error: str
    code: str


DEFAULT_ENDPOINT = "http://localhost:3000"


def api_request(base_url: str, path: str, method: str = "GET", body: dict | None = None) -> tuple[int, dict]:
    """Make an HTTP request to the API."""
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())
    except Exception as e:
        return 0, {"error": str(e), "code": "CONNECTION_ERROR"}


def run_tests(base_url: str) -> bool:
    """Run automated tests."""
    print("🧪 Testing elizaOS Vercel Edge Functions\n")

    passed = 0
    failed = 0

    # Test 1: Health check
    print("1️⃣  Testing health check...")
    status, data = api_request(base_url, "/api/health")
    print(f"   Status: {status}")
    print(f"   Runtime: {data.get('runtime', 'N/A')}")
    print(f"   Version: {data.get('version', 'N/A')}")

    if status == 200 and data.get("status") == "healthy":
        print("   ✅ Health check passed\n")
        passed += 1
    else:
        print("   ❌ Health check failed\n")
        failed += 1

    # Test 2: Chat endpoint
    print("2️⃣  Testing chat endpoint...")
    start = time.time()
    status, data = api_request(base_url, "/api/chat", "POST", {
        "message": "Hello! What's 2 + 2?"
    })
    duration = int((time.time() - start) * 1000)

    print(f"   Status: {status}")
    print(f"   Duration: {duration}ms")
    print(f"   Conversation ID: {data.get('conversationId', 'N/A')}")
    response_text = data.get("response", "")
    print(f"   Response: {response_text[:100]}{'...' if len(response_text) > 100 else ''}")

    if status == 200 and response_text:
        print("   ✅ Chat endpoint passed\n")
        passed += 1
    else:
        print("   ❌ Chat endpoint failed\n")
        failed += 1

    # Test 3: Validation (empty message)
    print("3️⃣  Testing validation (empty message)...")
    status, data = api_request(base_url, "/api/chat", "POST", {"message": ""})
    print(f"   Status: {status}")
    print(f"   Error: {data.get('error', 'N/A')}")

    if status == 400 and data.get("code") == "BAD_REQUEST":
        print("   ✅ Validation passed\n")
        passed += 1
    else:
        print("   ❌ Validation failed\n")
        failed += 1

    # Test 4: 404 handling
    print("4️⃣  Testing 404 response...")
    status, data = api_request(base_url, "/api/unknown")
    print(f"   Status: {status}")

    if status == 404 and data.get("code") == "NOT_FOUND":
        print("   ✅ 404 handling passed\n")
        passed += 1
    else:
        print("   ❌ 404 handling failed\n")
        failed += 1

    # Test 5: Method not allowed
    print("5️⃣  Testing method not allowed...")
    status, data = api_request(base_url, "/api/chat", "GET")
    print(f"   Status: {status}")

    if status == 405 and data.get("code") == "METHOD_NOT_ALLOWED":
        print("   ✅ Method handling passed\n")
        passed += 1
    else:
        print("   ❌ Method handling failed\n")
        failed += 1

    # Summary
    print("━" * 40)
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        print("\n❌ Some tests failed!")
        return False
    else:
        print("\n🎉 All tests passed!")
        return True


def interactive_mode(base_url: str) -> None:
    """Run interactive chat mode."""
    print("💬 Interactive Chat Mode")
    print('   Type your message and press Enter. Type "exit" to quit.\n')

    conversation_id: str | None = None

    while True:
        try:
            message = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋 Goodbye!")
            break

        if message.lower() == "exit":
            print("\n👋 Goodbye!")
            break

        if not message:
            continue

        body = {"message": message}
        if conversation_id:
            body["conversationId"] = conversation_id

        status, data = api_request(base_url, "/api/chat", "POST", body)

        if status == 200:
            conversation_id = data.get("conversationId")
            print(f"\nEliza: {data.get('response', 'No response')}\n")
        else:
            print(f"\n❌ Error: {data.get('error', 'Unknown error')}\n")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="elizaOS Vercel Edge Function Test Client"
    )
    parser.add_argument(
        "-e", "--endpoint",
        default=os.environ.get("VERCEL_URL", DEFAULT_ENDPOINT),
        help=f"API endpoint URL (default: {DEFAULT_ENDPOINT})"
    )
    parser.add_argument(
        "-i", "--interactive",
        action="store_true",
        help="Start interactive chat mode"
    )

    args = parser.parse_args()

    print(f"🔗 Using endpoint: {args.endpoint}\n")

    if args.interactive:
        interactive_mode(args.endpoint)
    else:
        success = run_tests(args.endpoint)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()










