"""Preserves the cloud voice contract on top of pinned Kokoro-FastAPI.

Cloud-api sends the legacy ``POST /api/tts`` request shape. The pinned upstream
only exposes OpenAI-compatible ``POST /v1/audio/speech``, so this module adds a
thin typed adapter while leaving model loading and audio generation upstream.
"""

from fastapi import Request
from pydantic import BaseModel, Field

from api.src.main import app
from api.src.routers.openai_compatible import create_speech
from api.src.structures import OpenAISpeechRequest


class CloudTTSRequest(BaseModel):
    """Request body sent by the cloud-api free TTS route."""

    text: str = Field(min_length=1)
    voice: str = Field(min_length=1)
    speed: float = Field(ge=0.25, le=4.0)


@app.post("/api/tts")
async def cloud_tts(payload: CloudTTSRequest, request: Request):
    """Translate the stable cloud contract into Kokoro's pinned API shape."""

    return await create_speech(
        OpenAISpeechRequest(
            model="kokoro",
            input=payload.text,
            voice=payload.voice,
            response_format="wav",
            speed=payload.speed,
            stream=True,
        ),
        request,
    )
