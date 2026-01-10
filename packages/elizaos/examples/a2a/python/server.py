"""
elizaOS A2A (Agent-to-Agent) Server - Python

An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
Uses real elizaOS runtime with OpenAI plugin.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime
from typing import Any

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# ============================================================================
# Configuration
# ============================================================================

PORT = int(os.environ.get("PORT", 3000))

CHARACTER = Character(
    name="Eliza",
    username="eliza",
    bio="A helpful AI assistant powered by elizaOS, available via A2A protocol.",
    system="You are a helpful, friendly AI assistant participating in agent-to-agent communication. Be concise, informative, and cooperative.",
)

# ============================================================================
# Agent Runtime
# ============================================================================

_runtime: AgentRuntime | None = None
_sessions: dict[str, dict[str, Any]] = {}


async def get_runtime() -> AgentRuntime:
    """Get or initialize the agent runtime."""
    global _runtime

    if _runtime is not None:
        return _runtime

    print("🚀 Initializing elizaOS runtime...")

    _runtime = AgentRuntime(
        character=CHARACTER,
        plugins=[get_openai_plugin()],
        log_level="INFO",
    )

    await _runtime.initialize()
    print("✅ elizaOS runtime initialized")

    return _runtime


def get_or_create_session(session_id: str) -> dict[str, Any]:
    """Get or create a session for the given session ID."""
    if session_id not in _sessions:
        _sessions[session_id] = {
            "room_id": uuid7(),
            "user_id": uuid7(),
        }
    return _sessions[session_id]


async def handle_chat(
    message: str,
    session_id: str,
    metadata: dict[str, Any] | None = None,
) -> str:
    """Send a message to the agent and get a response."""
    runtime = await get_runtime()
    session = get_or_create_session(session_id)

    # Create message memory
    content = Content(
        text=message,
        source="a2a",
        channel_type=ChannelType.DM.value,
    )

    if metadata:
        # Add metadata to content if needed
        pass

    msg = Memory(
        entity_id=session["user_id"],
        room_id=session["room_id"],
        content=content,
    )

    # Process message
    result = await runtime.message_service.handle_message(runtime, msg)

    if result and result.response_content and result.response_content.text:
        return result.response_content.text

    return "No response generated."


# ============================================================================
# Pydantic Models
# ============================================================================


class ChatRequest(BaseModel):
    """Request body for chat endpoint."""

    message: str
    sessionId: str | None = None
    context: dict[str, Any] | None = None


class ChatResponse(BaseModel):
    """Response body for chat endpoint."""

    response: str
    agentId: str
    sessionId: str
    timestamp: str


class HealthResponse(BaseModel):
    """Response body for health endpoint."""

    status: str
    agent: str
    timestamp: str


class AgentInfo(BaseModel):
    """Agent information response."""

    name: str
    bio: str
    agentId: str
    version: str
    capabilities: list[str]
    powered_by: str
    endpoints: dict[str, str]


# ============================================================================
# FastAPI App
# ============================================================================

app = FastAPI(
    title="elizaOS A2A Server",
    description="Agent-to-Agent communication server powered by elizaOS",
    version="1.0.0",
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


@app.get("/", response_model=AgentInfo)
async def agent_info() -> AgentInfo:
    """Get information about the agent."""
    runtime = await get_runtime()
    return AgentInfo(
        name=CHARACTER.name,
        bio=CHARACTER.bio or "An AI assistant",
        agentId=str(runtime.agent_id),
        version="1.0.0",
        capabilities=["chat", "reasoning", "multi-turn"],
        powered_by="elizaOS",
        endpoints={
            "POST /chat": "Send a message and receive a response",
            "POST /chat/stream": "Stream a response (SSE)",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint",
        },
    )


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    try:
        await get_runtime()
        return HealthResponse(
            status="healthy",
            agent=CHARACTER.name,
            timestamp=datetime.now().isoformat(),
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    x_agent_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
) -> ChatResponse:
    """Chat with the agent."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    session_id = request.sessionId or x_session_id or str(uuid7())

    # Build metadata
    metadata: dict[str, Any] = {}
    if request.context:
        metadata.update(request.context)
    if x_agent_id:
        metadata["callerAgentId"] = x_agent_id

    response = await handle_chat(request.message, session_id, metadata)
    runtime = await get_runtime()

    return ChatResponse(
        response=response,
        agentId=str(runtime.agent_id),
        sessionId=session_id,
        timestamp=datetime.now().isoformat(),
    )


@app.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    x_session_id: str | None = Header(None),
) -> StreamingResponse:
    """Stream a response from the agent."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    session_id = request.sessionId or x_session_id or str(uuid7())

    async def generate():
        runtime = await get_runtime()
        session = get_or_create_session(session_id)

        content = Content(
            text=request.message,
            source="a2a",
            channel_type=ChannelType.DM.value,
        )

        msg = Memory(
            entity_id=session["user_id"],
            room_id=session["room_id"],
            content=content,
        )

        result = await runtime.message_service.handle_message(runtime, msg)

        if result and result.response_content and result.response_content.text:
            # For now, send the whole response as one chunk
            # In a real streaming implementation, we'd yield chunks
            import json
            yield f"data: {json.dumps({'text': result.response_content.text})}\n\n"

        import json
        yield f"data: {json.dumps({'done': True})}\n\n"

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
    await get_runtime()
    print(f"\n🌐 elizaOS A2A Server (FastAPI)")
    print(f"   http://localhost:{PORT}\n")
    print("📚 Endpoints:")
    print("   GET  /            - Agent info")
    print("   GET  /health      - Health check")
    print("   POST /chat        - Chat with agent")
    print("   POST /chat/stream - Stream response (SSE)\n")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Cleanup on shutdown."""
    global _runtime
    if _runtime:
        await _runtime.stop()
    print("👋 Goodbye!")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)

