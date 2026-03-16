"""
elizaOS A2A (Agent-to-Agent) Server - Python

An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
Uses real elizaOS runtime (OpenAI optional).
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from datetime import datetime

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos.types.primitives import string_to_uuid
from elizaos_plugin_eliza_classic.plugin import get_eliza_classic_plugin
from elizaos_plugin_inmemorydb import InMemoryDatabaseAdapter, MemoryStorage
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_inmemorydb import plugin as inmemorydb_plugin

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


@dataclass(frozen=True)
class Session:
    room_id: str
    user_id: str


_sessions: dict[str, Session] = {}
_storage: MemoryStorage | None = None


def _should_use_openai() -> bool:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    return bool(key)


async def get_runtime() -> AgentRuntime:
    """Get or initialize the agent runtime."""
    global _runtime, _storage

    if _runtime is not None:
        return _runtime

    print("🚀 Initializing elizaOS runtime...")

    if _storage is None:
        _storage = MemoryStorage()

    agent_id = CHARACTER.id or string_to_uuid(CHARACTER.name)
    adapter = InMemoryDatabaseAdapter(_storage, agent_id)

    plugins: list[object] = []
    if _should_use_openai():
        plugins.append(get_openai_plugin())
    else:
        plugins.append(get_eliza_classic_plugin())

    _runtime = AgentRuntime(
        character=CHARACTER,
        adapter=adapter,
        plugins=plugins,
        log_level="INFO",
    )

    await _runtime.initialize()
    print("✅ elizaOS runtime initialized")

    return _runtime


def get_or_create_session(session_id: str) -> Session:
    """Get or create a session for the given session ID."""
    if session_id not in _sessions:
        _sessions[session_id] = Session(room_id=str(uuid7()), user_id=str(uuid7()))
    return _sessions[session_id]


async def handle_chat(
    message: str,
    session_id: str,
    metadata: dict[str, object] | None = None,
    callback: Callable[[Content], Awaitable[list[Memory]]] | None = None,
) -> str:
    """Send a message to the agent and get a response."""
    runtime = await get_runtime()
    session = get_or_create_session(session_id)

    # Create message memory. Content allows extra fields.
    content_kwargs: dict[str, object] = {
        "text": message,
        "source": "a2a",
        "channel_type": ChannelType.DM.value,
    }
    if metadata:
        content_kwargs.update(metadata)
    content = Content(**content_kwargs)

    msg = Memory(
        entity_id=session.user_id,
        room_id=session.room_id,
        content=content,
    )

    # Process message
    result = await runtime.message_service.handle_message(runtime, msg, callback=callback)

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
    context: dict[str, object] | None = None


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
    metadata: dict[str, object] = {}
    if request.context:
        metadata["context"] = request.context
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
    x_agent_id: str | None = Header(None),
) -> StreamingResponse:
    """Stream a response from the agent using true token-by-token streaming."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    session_id = request.sessionId or x_session_id or str(uuid7())

    metadata: dict[str, object] = {}
    if request.context:
        metadata["context"] = request.context
    if x_agent_id:
        metadata["callerAgentId"] = x_agent_id

    queue: asyncio.Queue[str] = asyncio.Queue()
    done = asyncio.Event()

    async def on_chunk(content: Content) -> list[Memory]:
        if content.text:
            await queue.put(content.text)
        return []

    async def run_message() -> None:
        try:
            _ = await handle_chat(
                request.message,
                session_id,
                metadata,
                callback=on_chunk,
            )
        finally:
            done.set()

    asyncio.create_task(run_message())

    async def generate():
        import json

        while True:
            if done.is_set() and queue.empty():
                break
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            yield f"data: {json.dumps({'text': chunk})}\n\n"

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

