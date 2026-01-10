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
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, TypedDict

from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

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


# Conversation state for streaming
@dataclass
class ConversationState:
    messages: list[dict[str, str]]
    created_at: float


# In-memory conversation store
_conversations: dict[str, ConversationState] = {}

# Singleton runtime
_runtime: AgentRuntime | None = None


def get_character() -> Character:
    """Create character from environment variables."""
    return Character(
        name=os.environ.get("CHARACTER_NAME", "Eliza"),
        username="eliza",
        bio=os.environ.get("CHARACTER_BIO", "A helpful AI assistant."),
        system=os.environ.get(
            "CHARACTER_SYSTEM",
            "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
        ),
    )


async def get_runtime() -> AgentRuntime:
    """Get or initialize the elizaOS runtime (singleton pattern)."""
    global _runtime

    if _runtime is not None:
        return _runtime

    logger.info("Initializing elizaOS runtime...")

    character = get_character()
    _runtime = AgentRuntime(
        character=character,
        plugins=[get_openai_plugin()],
    )

    await _runtime.initialize()
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


async def handle_chat(request: ChatRequest) -> ChatResponse:
    """Handle a chat message and return the response."""
    runtime = await get_runtime()

    # Generate IDs
    user_id = uuid7()
    room_id = uuid7()
    conversation_id = request.get("conversationId") or f"conv-{uuid7()}"

    # Create message
    message = Memory(
        entity_id=user_id,
        room_id=room_id,
        content=Content(
            text=request["message"],
            source="gcp-cloud-run",
            channel_type=ChannelType.DM.value,
        ),
    )

    # Process message
    result = await runtime.message_service.handle_message(runtime, message)

    response_text = ""
    if result and result.response_content and result.response_content.text:
        response_text = result.response_content.text

    return {
        "response": response_text or "I apologize, but I could not generate a response.",
        "conversationId": conversation_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def handle_stream_chat(
    request: ChatRequest,
    send_event: Callable[[str], Coroutine[Any, Any, None]],
) -> None:
    """Handle streaming chat using Server-Sent Events."""
    import httpx

    character = get_character()
    conversation_id = request.get("conversationId") or f"conv-{uuid7()}"

    # Get or create conversation state
    state = _conversations.get(conversation_id)
    if not state:
        state = ConversationState(
            messages=[{"role": "system", "content": character.system or ""}],
            created_at=datetime.now().timestamp(),
        )
        _conversations[conversation_id] = state

    # Add user message
    state.messages.append({"role": "user", "content": request["message"]})

    # Send metadata
    await send_event(json.dumps({"conversationId": conversation_id, "character": character.name}))

    # Get OpenAI config
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = os.environ.get("OPENAI_MODEL", "gpt-5-mini")
    api_key = os.environ.get("OPENAI_API_KEY")

    if not api_key:
        await send_event(json.dumps({"error": "OPENAI_API_KEY not set"}))
        await send_event("[DONE]")
        return

    full_response = ""

    try:
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": state.messages,
                    "temperature": 0.7,
                    "max_tokens": 1024,
                    "stream": True,
                },
                timeout=60.0,
            ) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    await send_event(json.dumps({"error": f"OpenAI error: {error_text.decode()}"}))
                    await send_event("[DONE]")
                    return

                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            continue

                        try:
                            parsed = json.loads(data)
                            content = parsed.get("choices", [{}])[0].get("delta", {}).get("content")
                            if content:
                                full_response += content
                                await send_event(json.dumps({"text": content}))
                        except json.JSONDecodeError:
                            pass

        # Store assistant response
        state.messages.append({"role": "assistant", "content": full_response})

        # Prune old conversations
        if len(_conversations) > 100:
            sorted_convos = sorted(_conversations.items(), key=lambda x: x[1].created_at)
            for conv_id, _ in sorted_convos[:-100]:
                del _conversations[conv_id]

    except Exception as e:
        logger.exception("Streaming error")
        await send_event(json.dumps({"error": str(e)}))

    await send_event("[DONE]")


def handle_health() -> HealthResponse:
    """Return health status."""
    return {
        "status": "healthy",
        "runtime": "python",
        "version": "1.0.0",
    }


def handle_info() -> InfoResponse:
    """Return service info."""
    character = get_character()
    return {
        "name": character.name,
        "bio": character.bio or "A helpful AI assistant.",
        "version": "1.0.0",
        "powered_by": "elizaOS",
        "endpoints": {
            "POST /chat": "Send a message and receive a response",
            "POST /chat/stream": "Send a message and receive a streaming response",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint",
        },
    }


# Flask application
try:
    from flask import Flask, Response, request, jsonify, stream_with_context
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
            result = asyncio.run(handle_chat(body))
            return jsonify(result)
        except ValueError as e:
            return jsonify({"error": str(e), "code": "BAD_REQUEST"}), 400
        except Exception as e:
            logger.exception("Chat error")
            return jsonify({"error": "Internal server error", "code": "INTERNAL_ERROR"}), 500

    @app.route("/chat/stream", methods=["POST"])
    def chat_stream():
        try:
            body = parse_request_body(request.get_data())
        except ValueError as e:
            return jsonify({"error": str(e), "code": "BAD_REQUEST"}), 400

        def generate():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            queue: asyncio.Queue[str | None] = asyncio.Queue()

            async def send_event(data: str) -> None:
                await queue.put(data)

            async def run_stream():
                try:
                    await handle_stream_chat(body, send_event)
                finally:
                    await queue.put(None)

            task = loop.create_task(run_stream())

            while True:
                event = loop.run_until_complete(queue.get())
                if event is None:
                    break
                yield f"data: {event}\n\n"

            loop.run_until_complete(task)
            loop.close()

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

except ImportError:
    # Flask not available, use built-in http server
    app = None


# Starlette/ASGI application (for production)
try:
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse, StreamingResponse
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
            result = await handle_chat(parsed)
            return JSONResponse(result)
        except ValueError as e:
            return JSONResponse({"error": str(e), "code": "BAD_REQUEST"}, status_code=400)
        except Exception as e:
            logger.exception("Chat error")
            return JSONResponse({"error": "Internal server error", "code": "INTERNAL_ERROR"}, status_code=500)

    async def asgi_stream(request: Request) -> StreamingResponse:
        try:
            body = await request.body()
            parsed = parse_request_body(body)
        except ValueError as e:
            return JSONResponse({"error": str(e), "code": "BAD_REQUEST"}, status_code=400)

        async def event_generator():
            queue: asyncio.Queue[str | None] = asyncio.Queue()

            async def send_event(data: str) -> None:
                await queue.put(data)

            task = asyncio.create_task(handle_stream_chat(parsed, send_event))

            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    yield f"data: {event}\n\n"
            finally:
                await task

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    asgi_routes = [
        Route("/", asgi_info, methods=["GET"]),
        Route("/health", asgi_health, methods=["GET"]),
        Route("/chat", asgi_chat, methods=["POST"]),
        Route("/chat/stream", asgi_stream, methods=["POST"]),
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
    logger.info(f"📡 Stream endpoint: http://localhost:{port}/chat/stream")

    if asgi_app:
        import uvicorn
        uvicorn.run(asgi_app, host="0.0.0.0", port=port)
    elif app:
        app.run(host="0.0.0.0", port=port)
    else:
        logger.error("No web framework available. Install flask or starlette.")
        exit(1)

