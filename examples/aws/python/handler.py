"""
AWS Lambda handler for elizaOS chat worker (Python)

This Lambda function processes chat messages and returns AI responses
using the elizaOS runtime with OpenAI as the LLM provider.

For local testing, run: python3 handler.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypedDict

# Configure logging
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


# Type definitions
class ChatRequest(TypedDict, total=False):
    message: str
    userId: str | None
    conversationId: str | None


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


class APIGatewayResponse(TypedDict):
    statusCode: int
    headers: dict[str, str]
    body: str


def load_env() -> None:
    """Load .env file from various locations."""
    script_dir = Path(__file__).parent
    env_paths = [
        script_dir / "../../../.env",  # Root .env
        script_dir / "../.env",        # aws/.env
        script_dir / ".env",           # python/.env
    ]

    for env_path in env_paths:
        env_path = env_path.resolve()
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        key, _, value = line.partition("=")
                        if key and value and key not in os.environ:
                            os.environ[key] = value
            logger.info(f"Loaded .env from {env_path}")
            break


# Character configuration
def get_character() -> dict[str, str]:
    """Get character configuration from environment."""
    return {
        "name": os.environ.get("CHARACTER_NAME", "Eliza"),
        "bio": os.environ.get("CHARACTER_BIO", "A helpful AI assistant."),
        "system": os.environ.get(
            "CHARACTER_SYSTEM",
            "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
        ),
    }


# Singleton runtime instance
_runtime = None
_runtime_initialized = False


async def get_runtime():
    """Get or create the elizaOS runtime (singleton pattern)."""
    global _runtime, _runtime_initialized
    
    if _runtime_initialized:
        return _runtime
    
    logger.info("Initializing elizaOS runtime...")
    
    from elizaos import Character
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_openai import get_openai_plugin
    
    character_config = get_character()
    character = Character(
        name=character_config["name"],
        bio=character_config["bio"],
        system=character_config["system"],
    )
    
    _runtime = AgentRuntime(
        character=character,
        plugins=[get_openai_plugin()],
    )
    
    await _runtime.initialize()
    _runtime_initialized = True
    
    logger.info("elizaOS runtime initialized successfully")
    return _runtime


def json_response(status_code: int, body: dict[str, Any]) -> APIGatewayResponse:
    """Create a JSON response with proper headers."""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
        "body": json.dumps(body),
    }


def parse_request_body(body: str | None) -> ChatRequest:
    """Parse and validate the incoming request body."""
    if not body:
        raise ValueError("Request body is required")

    data = json.loads(body)

    message = data.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("Message is required and must be a non-empty string")

    return {
        "message": message.strip(),
        "userId": data.get("userId"),
        "conversationId": data.get("conversationId"),
    }


async def handle_chat_async(request: ChatRequest) -> ChatResponse:
    """Handle a chat message using elizaOS runtime."""
    runtime = await get_runtime()
    
    # Generate IDs
    conversation_id = request.get("conversationId") or f"conv-{uuid.uuid4().hex[:12]}"

    # Route through the full message pipeline (planning/actions/providers/memory)
    from elizaos import ChannelType, Content, Memory, string_to_uuid

    user_id_raw = request.get("userId") or f"user-{uuid.uuid4().hex}"
    user_id = string_to_uuid(user_id_raw)
    room_id = string_to_uuid(conversation_id)

    message = Memory(
        entity_id=user_id,
        room_id=room_id,
        content=Content(
            text=request["message"],
            source="aws-lambda",
            channel_type=ChannelType.DM.value,
        ),
    )

    result = await runtime.message_service.handle_message(runtime, message)
    response_text = (
        result.response_content.text
        if result.response_content and result.response_content.text
        else ""
    )
    
    return {
        "response": str(response_text) or "I apologize, but I could not generate a response.",
        "conversationId": conversation_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def handle_chat(request: ChatRequest) -> ChatResponse:
    """Sync wrapper for async chat handler."""
    return asyncio.run(handle_chat_async(request))


def handler(event: dict[str, Any], context: Any) -> APIGatewayResponse:
    """Lambda entry point."""
    path = event.get("rawPath", event.get("path", "/"))
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    logger.info(f"{method} {path}")

    # Handle CORS preflight
    if method == "OPTIONS":
        return json_response(200, {"message": "OK"})

    # Health check endpoint
    if path in ("/health", "/"):
        if method == "GET":
            response: HealthResponse = {
                "status": "healthy",
                "runtime": "elizaos-python",
                "version": "1.0.0",
            }
            return json_response(200, response)

    # Chat endpoint
    if path == "/chat":
        if method != "POST":
            error: ErrorResponse = {
                "error": "Method not allowed",
                "code": "METHOD_NOT_ALLOWED",
            }
            return json_response(405, error)

        try:
            request = parse_request_body(event.get("body"))
            response = handle_chat(request)
            return json_response(200, response)
        except ValueError as e:
            logger.error(f"Validation error: {e}")
            return json_response(400, {"error": str(e), "code": "BAD_REQUEST"})
        except Exception as e:
            logger.exception("Chat error")
            return json_response(500, {"error": "Internal server error", "code": "INTERNAL_ERROR"})

    # Not found
    return json_response(404, {"error": "Not found", "code": "NOT_FOUND"})


# For local testing
if __name__ == "__main__":
    import sys
    import time

    # Load environment variables
    load_env()

    if not os.environ.get("OPENAI_API_KEY"):
        print("❌ OPENAI_API_KEY environment variable is required")
        print("   Set it with: export OPENAI_API_KEY='your-key-here'")
        print("   Or create a .env file in the project root")
        sys.exit(1)

    print("🧪 Testing elizaOS AWS Lambda Handler (Python)\n")

    # Test 1: Health check
    print("1️⃣  Testing health check...")
    health_event = {
        "rawPath": "/health",
        "requestContext": {"http": {"method": "GET"}},
    }
    health_result = handler(health_event, None)
    print(f"   Status: {health_result['statusCode']}")
    print(f"   Body: {health_result['body']}")
    assert health_result["statusCode"] == 200, "Health check failed"
    print("   ✅ Health check passed\n")

    # Test 2: Chat message
    print("2️⃣  Testing chat endpoint with elizaOS runtime...")
    start = time.time()
    chat_event = {
        "rawPath": "/chat",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps({"message": "Hello! What's 2 + 2?"}),
    }
    chat_result = handler(chat_event, None)
    duration = int((time.time() - start) * 1000)
    print(f"   Status: {chat_result['statusCode']}")
    print(f"   Duration: {duration}ms")
    if chat_result["statusCode"] != 200:
        print(f"   ❌ Chat failed: {chat_result['body']}")
        sys.exit(1)
    response_data = json.loads(chat_result["body"])
    print(f"   Response: {response_data['response'][:100]}...")
    print(f"   Conversation ID: {response_data['conversationId']}")
    print("   ✅ Chat endpoint passed (elizaOS runtime working!)\n")

    # Test 3: Validation
    print("3️⃣  Testing validation (empty message)...")
    invalid_event = {
        "rawPath": "/chat",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps({"message": ""}),
    }
    invalid_result = handler(invalid_event, None)
    print(f"   Status: {invalid_result['statusCode']}")
    assert invalid_result["statusCode"] == 400, "Validation test failed"
    print("   ✅ Validation passed\n")

    # Test 4: 404
    print("4️⃣  Testing 404 response...")
    notfound_event = {
        "rawPath": "/unknown",
        "requestContext": {"http": {"method": "GET"}},
    }
    notfound_result = handler(notfound_event, None)
    print(f"   Status: {notfound_result['statusCode']}")
    assert notfound_result["statusCode"] == 404, "404 test failed"
    print("   ✅ 404 handling passed\n")

    print("🎉 All tests passed with elizaOS runtime!")
