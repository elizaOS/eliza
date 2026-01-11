#!/usr/bin/env python3
"""
Interactive test client for elizaOS AWS Lambda worker (Python)

Usage:
    python test-client.py --endpoint https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/chat
    python test-client.py --endpoint http://localhost:3000/chat
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import TypedDict

import httpx


class ChatResponse(TypedDict):
    response: str
    conversationId: str
    timestamp: str


class ErrorResponse(TypedDict):
    error: str
    code: str


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="elizaOS AWS Lambda Test Client",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python test-client.py --endpoint https://abc123.execute-api.us-east-1.amazonaws.com/prod/chat
  python test-client.py --endpoint http://localhost:3000/chat
        """,
    )
    parser.add_argument(
        "--endpoint",
        required=True,
        help="API endpoint URL",
    )
    parser.add_argument(
        "--conversation",
        default=None,
        help="Resume existing conversation",
    )
    return parser.parse_args()


def send_message(
    client: httpx.Client,
    endpoint: str,
    message: str,
    conversation_id: str | None,
) -> ChatResponse:
    """Send a message to the API."""
    body: dict[str, str] = {"message": message}
    if conversation_id:
        body["conversationId"] = conversation_id

    response = client.post(
        endpoint,
        json=body,
        timeout=60.0,
    )

    data = response.json()

    if response.status_code != 200:
        error = data
        raise Exception(f"API Error ({error.get('code', 'UNKNOWN')}): {error.get('error', 'Unknown error')}")

    return data


def check_health(client: httpx.Client, base_endpoint: str) -> bool:
    """Check API health."""
    health_endpoint = base_endpoint.replace("/chat", "/health").rstrip("/")
    response = client.get(health_endpoint, timeout=10.0)

    if response.status_code == 200:
        data = response.json()
        print(f"✅ Connected to {data.get('runtime', 'unknown')} runtime (v{data.get('version', '?')})\n")
        return True
    return False


def main() -> None:
    """Main entry point."""
    args = parse_args()
    endpoint = args.endpoint
    conversation_id = args.conversation

    print("\n🤖 elizaOS AWS Lambda Test Client\n")
    print(f"📡 Endpoint: {endpoint}\n")

    with httpx.Client() as client:
        # Check health
        check_health(client, endpoint)

        print("💬 Chat with Eliza (type 'exit' to quit, 'new' for new conversation)\n")

        while True:
            try:
                user_input = input("You: ")
            except EOFError:
                break
            except KeyboardInterrupt:
                print("\n")
                break

            text = user_input.strip()

            if text.lower() in ("exit", "quit"):
                print("\n👋 Goodbye!")
                break

            if text.lower() == "new":
                conversation_id = None
                print("\n🔄 Starting new conversation...\n")
                continue

            if not text:
                continue

            print("Eliza: ", end="", flush=True)
            start = time.time()
            response = send_message(client, endpoint, text, conversation_id)
            duration = int((time.time() - start) * 1000)

            print(response["response"])
            print(f"\n  [{duration}ms | {response['conversationId'][:8]}...]\n")

            conversation_id = response["conversationId"]


if __name__ == "__main__":
    main()





