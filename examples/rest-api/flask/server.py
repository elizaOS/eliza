"""
elizaOS REST API Example - Flask

A REST API server for chat with an AI agent.
Uses the canonical elizaOS runtime with messageService.handleMessage pattern.

Note: Flask is synchronous by default. For production use with async elizaOS,
consider using FastAPI or Quart instead.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime
from typing import TypedDict

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

from elizaos import (
    AgentRuntime,
    Character,
    Content,
    Memory,
    string_to_uuid,
    as_uuid,
)

# ============================================================================
# Configuration
# ============================================================================

PORT = int(os.environ.get("PORT", 3000))

CHARACTER_NAME = os.environ.get("CHARACTER_NAME", "Eliza")
CHARACTER_BIO = os.environ.get("CHARACTER_BIO", "A helpful AI assistant powered by elizaOS.")

# Create character with settings
character = Character(
    name=CHARACTER_NAME,
    bio=CHARACTER_BIO,
    settings={
        "secrets": {
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
        }
    },
)

# ============================================================================
# Runtime State
# ============================================================================

runtime: AgentRuntime | None = None
init_error: str | None = None
_event_loop: asyncio.AbstractEventLoop | None = None

# Session info
room_id = string_to_uuid("rest-api-room")
world_id = string_to_uuid("rest-api-world")


def get_event_loop() -> asyncio.AbstractEventLoop:
    """Get or create an event loop for running async code."""
    global _event_loop
    if _event_loop is None or _event_loop.is_closed():
        _event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_event_loop)
    return _event_loop


def run_async(coro):
    """Run an async coroutine in the event loop."""
    loop = get_event_loop()
    return loop.run_until_complete(coro)


async def _init_runtime() -> AgentRuntime:
    """Initialize the elizaOS runtime."""
    global runtime, init_error

    if runtime is not None:
        return runtime

    try:
        print("🚀 Initializing elizaOS runtime...")

        # Import plugins
        try:
            from elizaos.plugins.openai import openai_plugin
            from elizaos.plugins.sql import sql_plugin

            new_runtime = AgentRuntime(
                character=character,
                plugins=[sql_plugin, openai_plugin],
            )
        except ImportError as e:
            print(f"⚠️ Could not import plugins: {e}")
            print("💡 Initializing with basic runtime...")
            new_runtime = AgentRuntime(character=character)

        await new_runtime.initialize()

        print("✅ elizaOS runtime initialized")
        runtime = new_runtime
        return new_runtime
    except Exception as e:
        init_error = str(e)
        print(f"❌ Failed to initialize elizaOS runtime: {e}")
        raise


def get_runtime() -> AgentRuntime:
    """Get or initialize the elizaOS runtime (sync wrapper)."""
    return run_async(_init_runtime())


# ============================================================================
# Flask App
# ============================================================================

app = Flask(__name__)
CORS(app)


# ============================================================================
# Type Definitions
# ============================================================================


class ChatRequest(TypedDict, total=False):
    message: str
    userId: str


# ============================================================================
# Routes
# ============================================================================


@app.route("/", methods=["GET"])
def info() -> Response:
    """Get information about the agent."""
    return jsonify(
        {
            "name": CHARACTER_NAME,
            "bio": CHARACTER_BIO,
            "version": "2.0.0",
            "powered_by": "elizaOS",
            "framework": "Flask",
            "mode": "elizaos" if runtime else "initializing",
            "error": init_error,
            "endpoints": {
                "POST /chat": "Send a message and receive a response",
                "POST /chat/stream": "Send a message and receive a streaming response",
                "GET /health": "Health check endpoint",
                "GET /": "This info endpoint",
            },
        }
    )


@app.route("/health", methods=["GET"])
def health() -> Response:
    """Health check endpoint."""
    return jsonify(
        {
            "status": "healthy" if runtime else "initializing",
            "character": CHARACTER_NAME,
            "error": init_error,
            "timestamp": datetime.now().isoformat(),
        }
    )


@app.route("/chat", methods=["POST"])
def chat() -> Response | tuple[Response, int]:
    """Chat with the agent using the canonical runtime pattern."""
    data: ChatRequest = request.get_json() or {}  # type: ignore[assignment]

    message = data.get("message", "")
    if not message or not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Message is required"}), 400

    user_id = data.get("userId") or str(uuid.uuid4())

    try:
        rt = get_runtime()

        async def _process_message() -> str:
            # Ensure connection for this user
            await rt.ensure_connection(
                entity_id=as_uuid(user_id),
                room_id=room_id,
                world_id=world_id,
                user_name="User",
                source="rest-api",
                channel_id="flask-chat",
                server_id="flask-server",
                channel_type="API",
            )

            # Create message memory
            message_memory = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entityId=as_uuid(user_id),
                roomId=room_id,
                content=Content(
                    text=message,
                    source="rest_api",
                ),
            )

            # Process message through the runtime's message service
            response_text = ""

            async def callback(content: Content) -> list[Memory]:
                nonlocal response_text
                if content and content.text:
                    response_text += content.text
                return []

            await rt.message_service.handle_message(rt, message_memory, callback)
            return response_text

        response_text = run_async(_process_message())

        return jsonify(
            {
                "response": response_text,
                "character": CHARACTER_NAME,
                "userId": user_id,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/chat/stream", methods=["POST"])
def chat_stream() -> Response | tuple[Response, int]:
    """Chat with the agent and receive a streaming response."""
    data: ChatRequest = request.get_json() or {}  # type: ignore[assignment]

    message = data.get("message", "")
    if not message or not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Message is required"}), 400

    user_id = data.get("userId") or str(uuid.uuid4())

    def generate():
        import json

        try:
            rt = get_runtime()

            async def _process_message():
                await rt.ensure_connection(
                    entity_id=as_uuid(user_id),
                    room_id=room_id,
                    world_id=world_id,
                    user_name="User",
                    source="rest-api",
                    channel_id="flask-chat",
                    server_id="flask-server",
                    channel_type="API",
                )

                message_memory = Memory(
                    id=as_uuid(str(uuid.uuid4())),
                    entityId=as_uuid(user_id),
                    roomId=room_id,
                    content=Content(
                        text=message,
                        source="rest_api",
                    ),
                )

                # Process message
                response_text = ""

                async def callback(content: Content) -> list[Memory]:
                    nonlocal response_text
                    if content and content.text:
                        response_text += content.text
                    return []

                await rt.message_service.handle_message(rt, message_memory, callback)
                return response_text

            response_text = run_async(_process_message())
            yield f"data: {json.dumps({'text': response_text})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ============================================================================
# Startup
# ============================================================================


def main() -> None:
    """Start the Flask server."""
    print(f"\n🌐 elizaOS REST API (Flask)")
    print(f"   http://localhost:{PORT}\n")
    print("📚 Endpoints:")
    print("   GET  /            - Agent info")
    print("   GET  /health      - Health check")
    print("   POST /chat        - Chat with agent")
    print("   POST /chat/stream - Chat with streaming response\n")

    # Pre-initialize the runtime
    try:
        get_runtime()
    except Exception:
        print("Failed to initialize runtime on startup")

    app.run(host="0.0.0.0", port=PORT, debug=False)


if __name__ == "__main__":
    main()
