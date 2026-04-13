"""
GCP Cloud Run handler for elizaOS chat worker (Python)

This Cloud Run service processes chat messages and returns AI responses
using the elizaOS runtime with OpenAI as the LLM provider.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict

# Configure logging
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)


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


class InfoResponse(TypedDict):
    name: str
    bio: str
    version: str
    powered_by: str
    endpoints: dict[str, str]


class ErrorResponse(TypedDict):
    error: str
    code: str


# Character configuration
def get_character_config() -> dict[str, str]:
    """Get character configuration from environment."""
    return {
        "name": os.environ.get("CHARACTER_NAME", "Eliza"),
        "bio": os.environ.get("CHARACTER_BIO", "A helpful AI assistant."),
        "system": os.environ.get(
            "CHARACTER_SYSTEM",
            "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
        ),
    }


# Singleton runtime
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

    character_config = get_character_config()
    character = Character(
        name=character_config["name"],
        username="eliza",
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


def parse_request_body(body: str | bytes | None) -> ChatRequest:
    """Parse and validate the incoming request body."""
    if not body:
        raise ValueError("Request body is required")

    if isinstance(body, bytes):
        body = body.decode("utf-8")

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

    # Generate conversation ID
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
            source="gcp",
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


def handle_health() -> HealthResponse:
    """Return health status."""
    return {
        "status": "healthy",
        "runtime": "elizaos-python",
        "version": "2.0.0-alpha",
    }


def handle_info() -> InfoResponse:
    """Return service info."""
    character_config = get_character_config()
    return {
        "name": character_config["name"],
        "bio": character_config["bio"],
        "version": "2.0.0-alpha",
        "powered_by": "elizaOS",
        "endpoints": {
            "POST /chat": "Send a message and receive a response",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint",
        },
    }


# Flask application
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS

    app = Flask(__name__)
    CORS(app)

    @app.route("/", methods=["GET"])
    def info():
        return jsonify(handle_info())

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify(handle_health())

    @app.route("/chat", methods=["POST"])
    def chat():
        try:
            body = parse_request_body(request.get_data())
            result = asyncio.run(handle_chat_async(body))
            return jsonify(result)
        except ValueError as e:
            return jsonify({"error": str(e), "code": "BAD_REQUEST"}), 400
        except Exception as e:
            logger.exception("Chat error")
            return jsonify({"error": "Internal server error", "code": "INTERNAL_ERROR"}), 500

except ImportError:
    # Flask not available, use built-in http server
    app = None


# Starlette/ASGI application (for production)
try:
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from starlette.requests import Request

    async def asgi_info(request: Request) -> JSONResponse:
        return JSONResponse(handle_info())

    async def asgi_health(request: Request) -> JSONResponse:
        return JSONResponse(handle_health())

    async def asgi_chat(request: Request) -> JSONResponse:
        try:
            body = await request.body()
            parsed = parse_request_body(body)
            result = await handle_chat_async(parsed)
            return JSONResponse(result)
        except ValueError as e:
            return JSONResponse({"error": str(e), "code": "BAD_REQUEST"}, status_code=400)
        except Exception as e:
            logger.exception("Chat error")
            return JSONResponse({"error": "Internal server error", "code": "INTERNAL_ERROR"}, status_code=500)

    asgi_routes = [
        Route("/", asgi_info, methods=["GET"]),
        Route("/health", asgi_health, methods=["GET"]),
        Route("/chat", asgi_chat, methods=["POST"]),
    ]

    asgi_app = Starlette(routes=asgi_routes)

except ImportError:
    asgi_app = None


# Entry point
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))

    logger.info(f"🚀 elizaOS Cloud Run worker starting on port {port}")
    logger.info(f"📍 Health check: http://localhost:{port}/health")
    logger.info(f"💬 Chat endpoint: http://localhost:{port}/chat")

    if asgi_app:
        import uvicorn
        uvicorn.run(asgi_app, host="0.0.0.0", port=port)
    elif app:
        app.run(host="0.0.0.0", port=port)
    else:
        logger.error("No web framework available. Install flask or starlette.")
        exit(1)
