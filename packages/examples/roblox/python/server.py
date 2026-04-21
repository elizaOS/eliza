from __future__ import annotations

import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# Allow running from the monorepo without pip-installing Python packages.
_HERE = Path(__file__).resolve()
_PY_PACKAGES_ROOT = (_HERE.parent / "../../../packages/python").resolve()
if _PY_PACKAGES_ROOT.exists():
    sys.path.insert(0, str(_PY_PACKAGES_ROOT))

_ROBLOX_PLUGIN_ROOT = (_HERE.parent / "../../../plugins/plugin-roblox/python").resolve()
if _ROBLOX_PLUGIN_ROOT.exists():
    sys.path.insert(0, str(_ROBLOX_PLUGIN_ROOT))

from elizaos import Character, ChannelType, Content, Memory  # noqa: E402
from elizaos.runtime import AgentRuntime  # noqa: E402
from elizaos_plugin_openai import get_openai_plugin  # noqa: E402
from elizaos_plugin_roblox import get_roblox_plugin  # noqa: E402

try:
    from elizaos_plugin_eliza_classic import get_eliza_classic_plugin
except ModuleNotFoundError:  # pragma: no cover
    get_eliza_classic_plugin = None  # type: ignore[assignment]


PORT = int(os.environ.get("PORT", "3041"))


class RobloxChatRequest(BaseModel):
    playerId: int
    playerName: str
    text: str
    placeId: str | None = None
    jobId: str | None = None


class RobloxChatResponse(BaseModel):
    reply: str
    agentName: str


@dataclass(frozen=True)
class RuntimeHolder:
    runtime: AgentRuntime | None
    character: Character


def create_runtime() -> RuntimeHolder:
    character = Character(
        name="Eliza",
        username="eliza",
        bio="A helpful Roblox guide NPC.",
        system=(
            "You are a helpful Roblox guide. Be concise. "
            "If the user asks you to do something in-game, respond clearly."
        ),
    )

    roblox_plugin = get_roblox_plugin()

    if os.environ.get("OPENAI_API_KEY"):
        runtime = AgentRuntime(character=character, plugins=[get_openai_plugin(), roblox_plugin])
        return RuntimeHolder(runtime=runtime, character=character)

    if get_eliza_classic_plugin is not None:
        runtime = AgentRuntime(character=character, plugins=[get_eliza_classic_plugin(), roblox_plugin])
        return RuntimeHolder(runtime=runtime, character=character)

    # Minimal fallback: runnable without extra plugin packages.
    return RuntimeHolder(runtime=None, character=character)


holder = create_runtime()


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    if holder.runtime is not None:
        await holder.runtime.initialize()
    yield
    if holder.runtime is not None:
        await holder.runtime.stop()


app = FastAPI(title="elizaOS Roblox bridge", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/roblox/chat", response_model=RobloxChatResponse)
async def roblox_chat(request: Request, body: RobloxChatRequest) -> RobloxChatResponse:
    shared_secret = os.environ.get("ELIZA_ROBLOX_SHARED_SECRET", "")
    if shared_secret:
        header_secret = request.headers.get("x-eliza-secret", "")
        if header_secret != shared_secret:
            raise HTTPException(status_code=401, detail="Unauthorized")

    # We keep a stable user/room mapping so memory stays coherent:
    user_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"roblox:user:{body.playerId}")
    room_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"roblox:job:{body.jobId or 'unknown'}")

    message = Memory(
        entity_id=user_uuid,
        room_id=room_uuid,
        content=Content(
            text=body.text,
            source="roblox_chat",
            channel_type=ChannelType.DM.value,
        ),
    )

    if holder.runtime is None:
        reply = f"I heard you say: {body.text}"
    else:
        result = await holder.runtime.message_service.handle_message(holder.runtime, message)
        reply = result.response_content.text if result.response_content and result.response_content.text else ""

        if os.environ.get("ROBLOX_ECHO_TO_GAME", "").lower() == "true":
            svc = holder.runtime.get_service("roblox")
            if svc is not None and hasattr(svc, "send_message"):
                try:
                    await svc.send_message(reply or "(no response)", None)
                except Exception:
                    # Echo is best-effort; never break inbound chat.
                    pass

    return RobloxChatResponse(reply=reply or "(no response)", agentName=holder.character.name)


if __name__ == "__main__":
    import uvicorn

    print(f"🌐 Roblox agent bridge listening on http://localhost:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)

