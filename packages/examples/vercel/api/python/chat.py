"""
Vercel Serverless Function - Chat Endpoint (Python)

This Serverless Function processes chat messages and returns AI responses
using the elizaOS runtime with OpenAI as the LLM provider.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import TypedDict

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


# Singleton runtime instance
_runtime = None
_runtime_initialized = False


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
            source="vercel",
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


class handler(BaseHTTPRequestHandler):
    """Chat endpoint handler."""

    def _send_json_response(self, status_code: int, body: dict) -> None:
        """Send a JSON response with proper headers."""
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests."""
        self._send_json_response(200, {"message": "OK"})

    def do_GET(self) -> None:
        """Handle GET requests (method not allowed)."""
        self._send_json_response(405, {
            "error": "Method not allowed",
            "code": "METHOD_NOT_ALLOWED",
        })

    def do_POST(self) -> None:
        """Handle POST requests (chat)."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else None

            request = parse_request_body(body)
            response = handle_chat(request)
            self._send_json_response(200, response)
        except ValueError as e:
            logger.error(f"Validation error: {e}")
            self._send_json_response(400, {"error": str(e), "code": "BAD_REQUEST"})
        except Exception:
            logger.exception("Chat error")
            self._send_json_response(500, {"error": "Internal server error", "code": "INTERNAL_ERROR"})










