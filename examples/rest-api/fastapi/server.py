"""
elizaOS REST API Example - FastAPI

A REST API server for chat with an AI agent.
Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from elizaos import (
    AgentRuntime,
    Character,
    Content,
    Memory,
    Room,
    World,
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

# Session info
room_id = string_to_uuid("rest-api-room")
world_id = string_to_uuid("rest-api-world")


async def get_runtime() -> AgentRuntime:
    """Get or initialize the elizaOS runtime."""
    global runtime, init_error

    if runtime is not None:
        return runtime

    try:
        print("🚀 Initializing elizaOS runtime...")

        # Import plugins
        from elizaos.plugins.openai import openai_plugin
        from elizaos.plugins.sql import sql_plugin

        new_runtime = AgentRuntime(
            character=character,
            plugins=[sql_plugin, openai_plugin],
        )

        await new_runtime.initialize()

        print("✅ elizaOS runtime initialized")
        runtime = new_runtime
        return new_runtime
    except ImportError as e:
        # Fallback if plugins are not available
        print(f"⚠️ Could not import plugins: {e}")
        print("💡 Initializing with basic runtime...")

        new_runtime = AgentRuntime(character=character)
        await new_runtime.initialize()

        print("✅ elizaOS runtime initialized (basic mode)")
        runtime = new_runtime
        return new_runtime
    except Exception as e:
        init_error = str(e)
        print(f"❌ Failed to initialize elizaOS runtime: {e}")
        raise


# ============================================================================
# Pydantic Models
# ============================================================================


class ChatRequest(BaseModel):
    """Request body for chat endpoint."""

    message: str
    userId: Optional[str] = None


class ChatResponse(BaseModel):
    """Response body for chat endpoint."""

    response: str
    character: str
    userId: str


class HealthResponse(BaseModel):
    """Response body for health endpoint."""

    status: str
    character: str
    error: Optional[str] = None
    timestamp: str


class InfoResponse(BaseModel):
    """Response body for info endpoint."""

    name: str
    bio: str
    version: str
    powered_by: str
    framework: str
    mode: str
    error: Optional[str] = None
    endpoints: dict[str, str]


class ErrorResponse(BaseModel):
    """Error response body."""

    error: str


# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(
    title="elizaOS REST API",
    description="Chat with an elizaOS agent using FastAPI",
    version="2.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Routes
# ============================================================================


@app.get("/", response_model=InfoResponse)
async def info() -> InfoResponse:
    """Get information about the agent."""
    return InfoResponse(
        name=CHARACTER_NAME,
        bio=CHARACTER_BIO,
        version="2.0.0",
        powered_by="elizaOS",
        framework="FastAPI",
        mode="elizaos" if runtime else "initializing",
        error=init_error,
        endpoints={
            "POST /chat": "Send a message and receive a response",
            "POST /chat/stream": "Send a message and receive a streaming response",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint",
        },
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(
        status="healthy" if runtime else "initializing",
        character=CHARACTER_NAME,
        error=init_error,
        timestamp=datetime.now().isoformat(),
    )


@app.post("/chat", response_model=ChatResponse, responses={400: {"model": ErrorResponse}})
async def chat(request: ChatRequest) -> ChatResponse:
    """Chat with the agent using the canonical runtime pattern."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    user_id = request.userId or str(uuid.uuid4())

    try:
        rt = await get_runtime()

        # Ensure connection for this user
        await rt.ensure_connection(
            entity_id=as_uuid(user_id),
            room_id=room_id,
            world_id=world_id,
            user_name="User",
            source="rest-api",
            channel_id="fastapi-chat",
            server_id="fastapi-server",
            channel_type="API",
        )

        # Create message memory
        message_memory = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entityId=as_uuid(user_id),
            roomId=room_id,
            content=Content(
                text=request.message,
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

        return ChatResponse(
            response=response_text,
            character=CHARACTER_NAME,
            userId=user_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Chat with the agent and receive a streaming response."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    user_id = request.userId or str(uuid.uuid4())

    async def generate():
        try:
            rt = await get_runtime()

            await rt.ensure_connection(
                entity_id=as_uuid(user_id),
                room_id=room_id,
                world_id=world_id,
                user_name="User",
                source="rest-api",
                channel_id="fastapi-chat",
                server_id="fastapi-server",
                channel_type="API",
            )

            message_memory = Memory(
                id=as_uuid(str(uuid.uuid4())),
                entityId=as_uuid(user_id),
                roomId=room_id,
                content=Content(
                    text=request.message,
                    source="rest_api",
                ),
            )

            import json

            async def callback(content: Content) -> list[Memory]:
                return []

            # Use streaming if available
            if hasattr(rt.message_service, "handle_message_stream"):
                async for chunk in rt.message_service.handle_message_stream(rt, message_memory):
                    if isinstance(chunk, str):
                        yield f"data: {json.dumps({'text': chunk})}\n\n"
            else:
                # Fallback to non-streaming
                response_text = ""

                async def stream_callback(content: Content) -> list[Memory]:
                    nonlocal response_text
                    if content and content.text:
                        response_text += content.text
                    return []

                await rt.message_service.handle_message(rt, message_memory, stream_callback)
                yield f"data: {json.dumps({'text': response_text})}\n\n"

            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            import json

            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ============================================================================
# Startup
# ============================================================================


@app.on_event("startup")
async def startup_event() -> None:
    """Initialize the application."""
    print(f"\n🌐 elizaOS REST API (FastAPI)")
    print(f"   http://localhost:{PORT}\n")
    print("📚 Endpoints:")
    print("   GET  /            - Agent info")
    print("   GET  /health      - Health check")
    print("   POST /chat        - Chat with agent")
    print("   POST /chat/stream - Chat with streaming response\n")

    # Pre-initialize the runtime
    try:
        await get_runtime()
    except Exception:
        print("Failed to initialize runtime on startup")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
