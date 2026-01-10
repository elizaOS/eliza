"""
elizaOS REST API Example - FastAPI

A simple REST API server for chat with an AI agent.
Uses plugin-localdb for storage and plugin-eliza-classic for responses.
No API keys or external services required.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from elizaos_plugin_eliza_classic import ElizaClassicPlugin, get_greeting

# ============================================================================
# Configuration
# ============================================================================

PORT = int(os.environ.get("PORT", 3000))

CHARACTER_NAME = "Eliza"
CHARACTER_BIO = "A classic pattern-matching psychotherapist simulation."

# ============================================================================
# ELIZA Plugin
# ============================================================================

eliza = ElizaClassicPlugin()

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
    timestamp: str


class InfoResponse(BaseModel):
    """Response body for info endpoint."""

    name: str
    bio: str
    version: str
    powered_by: str
    framework: str
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


@app.get("/", response_model=InfoResponse)
async def info() -> InfoResponse:
    """Get information about the agent."""
    return InfoResponse(
        name=CHARACTER_NAME,
        bio=CHARACTER_BIO,
        version="1.0.0",
        powered_by="elizaOS",
        framework="FastAPI",
        endpoints={
            "POST /chat": "Send a message and receive a response",
            "GET /health": "Health check endpoint",
            "GET /": "This info endpoint",
        },
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(
        status="healthy",
        character=CHARACTER_NAME,
        timestamp=datetime.now().isoformat(),
    )


@app.post("/chat", response_model=ChatResponse, responses={400: {"model": ErrorResponse}})
async def chat(request: ChatRequest) -> ChatResponse:
    """Chat with the agent."""
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    user_id = request.userId or str(uuid.uuid4())

    # Add a small delay to simulate processing
    await asyncio.sleep(0.1)

    # Generate response using ELIZA
    response = eliza.generate_response(request.message)

    return ChatResponse(
        response=response,
        character=CHARACTER_NAME,
        userId=user_id,
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
    print("   GET  /       - Agent info")
    print("   GET  /health - Health check")
    print("   POST /chat   - Chat with agent\n")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)




