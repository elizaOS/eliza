from __future__ import annotations

import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from elizaos_plugin_minecraft.protocol import coerce_json_object
from elizaos_plugin_minecraft.service import MinecraftService
from elizaos_plugin_minecraft.types import MinecraftConfig

logger = logging.getLogger(__name__)

ActionHandler = Callable[[str], Awaitable[object]]
ProviderHandler = Callable[[], Awaitable[object]]


@dataclass
class Waypoint:
    """A named waypoint with coordinates."""

    name: str
    x: float
    y: float
    z: float
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class MinecraftPlugin:
    name: str = "plugin-minecraft"
    description: str = "Minecraft automation plugin (Mineflayer bridge client)"
    config: MinecraftConfig = field(default_factory=MinecraftConfig)
    service: MinecraftService | None = None
    actions: dict[str, ActionHandler] = field(default_factory=dict)
    providers: dict[str, ProviderHandler] = field(default_factory=dict)
    waypoints: dict[str, Waypoint] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.actions = {
            "MC_CONNECT": self._wrap_action(self._connect),
            "MC_DISCONNECT": self._wrap_action(self._disconnect),
            "MC_CHAT": self._wrap_action(self._chat),
            "MC_GOTO": self._wrap_action(self._goto),
            "MC_STOP": self._wrap_action(self._stop),
            "MC_LOOK": self._wrap_action(self._look),
            "MC_CONTROL": self._wrap_action(self._control),
            "MC_DIG": self._wrap_action(self._dig),
            "MC_PLACE": self._wrap_action(self._place),
            "MC_ATTACK": self._wrap_action(self._attack),
            "MC_SCAN": self._wrap_action(self._scan),
            "MC_WAYPOINT_SET": self._wrap_action(self._waypoint_set),
            "MC_WAYPOINT_DELETE": self._wrap_action(self._waypoint_delete),
            "MC_WAYPOINT_LIST": self._wrap_action(self._waypoint_list),
            "MC_WAYPOINT_GOTO": self._wrap_action(self._waypoint_goto),
        }
        self.providers = {
            "MC_WORLD_STATE": self._wrap_provider(self._world_state),
            "MC_VISION": self._wrap_provider(self._vision),
            "MC_WAYPOINTS": self._wrap_provider(self._waypoints_provider),
        }

    def _wrap_action(self, action: Callable[[str], Awaitable[object]]) -> ActionHandler:
        async def wrapper(message: str) -> object:
            if self.service is None:
                raise RuntimeError("Minecraft service not initialized")
            return await action(message)

        return wrapper

    def _wrap_provider(self, provider: Callable[[], Awaitable[object]]) -> ProviderHandler:
        async def wrapper() -> object:
            if self.service is None:
                raise RuntimeError("Minecraft service not initialized")
            return await provider()

        return wrapper

    async def init(self) -> None:
        self.config = MinecraftConfig(
            server_port=int(os.getenv("MC_SERVER_PORT", "3457")),
        )
        self.service = MinecraftService(self.config)
        await self.service.start()

    async def stop(self) -> None:
        if self.service is not None:
            await self.service.stop()
        self.service = None

    async def handle_action(self, action_name: str, message: str) -> object:
        handler = self.actions.get(action_name)
        if handler is None:
            raise ValueError(f"Unknown action: {action_name}")
        return await handler(message)

    async def get_provider(self, provider_name: str) -> object:
        provider = self.providers.get(provider_name)
        if provider is None:
            raise ValueError(f"Unknown provider: {provider_name}")
        return await provider()

    async def _connect(self, message: str) -> object:
        # Optional JSON overrides supported: {"host": "...", "port": 25565, "username": "...", "auth": "...", "version":"..."}
        overrides = {}
        if message.strip().startswith("{") and message.strip().endswith("}"):
            try:
                parsed = json.loads(message)
                coerced = coerce_json_object(parsed)
                if coerced is not None:
                    overrides = coerced
            except (json.JSONDecodeError, TypeError):
                overrides = {}

        assert self.service is not None
        bot_id = await self.service.create_bot(overrides)
        return {"botId": bot_id}

    async def _disconnect(self, _message: str) -> object:
        assert self.service is not None
        await self.service.destroy_bot()
        return {"disconnected": True}

    async def _chat(self, message: str) -> object:
        assert self.service is not None
        await self.service.request("chat", {"message": message})
        return {"sent": True}

    async def _goto(self, message: str) -> object:
        assert self.service is not None
        coords = message.strip()
        if coords.startswith("{") and coords.endswith("}"):
            parsed = json.loads(coords)
            coerced = coerce_json_object(parsed)
            if coerced is not None:
                return await self.service.request("goto", coerced)
        parts = coords.split()
        if len(parts) < 3:
            raise ValueError("Expected 'x y z'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        return await self.service.request("goto", {"x": x, "y": y, "z": z})

    async def _stop(self, _message: str) -> object:
        assert self.service is not None
        return await self.service.request("stop", {})

    async def _look(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 2:
            raise ValueError("Expected 'yaw pitch'")
        yaw, pitch = (float(parts[0]), float(parts[1]))
        return await self.service.request("look", {"yaw": yaw, "pitch": pitch})

    async def _control(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 2:
            raise ValueError("Expected 'control true|false [durationMs]'")
        control = parts[0]
        state = parts[1].lower() == "true"
        duration_ms = int(parts[2]) if len(parts) >= 3 else None
        payload = {"control": control, "state": state}
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        return await self.service.request("control", payload)

    async def _dig(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 3:
            raise ValueError("Expected 'x y z'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        return await self.service.request("dig", {"x": x, "y": y, "z": z})

    async def _place(self, message: str) -> object:
        assert self.service is not None
        parts = message.strip().split()
        if len(parts) < 4:
            raise ValueError("Expected 'x y z face'")
        x, y, z = (float(parts[0]), float(parts[1]), float(parts[2]))
        face = parts[3]
        return await self.service.request("place", {"x": x, "y": y, "z": z, "face": face})

    async def _attack(self, message: str) -> object:
        assert self.service is not None
        entity_id = int(message.strip())
        return await self.service.request("attack", {"entityId": entity_id})

    async def _world_state(self) -> object:
        assert self.service is not None
        return await self.service.get_state()

    async def _scan(self, message: str) -> object:
        """Scan for nearby blocks. Accepts optional JSON: {"blocks": [...], "radius": 16, "maxResults": 32}"""
        assert self.service is not None
        params: dict[str, object] = {}
        if message.strip().startswith("{") and message.strip().endswith("}"):
            try:
                parsed = json.loads(message)
                coerced = coerce_json_object(parsed)
                if coerced is not None:
                    if "blocks" in coerced and isinstance(coerced["blocks"], list):
                        params["blocks"] = coerced["blocks"]
                    if "radius" in coerced and isinstance(coerced["radius"], int | float):
                        params["radius"] = int(coerced["radius"])
                    if "maxResults" in coerced and isinstance(coerced["maxResults"], int | float):
                        params["maxResults"] = int(coerced["maxResults"])
            except (json.JSONDecodeError, TypeError):
                pass

        result = await self.service.request("scan", params)
        blocks = result.get("blocks", []) if isinstance(result, dict) else []
        return {
            "text": f"Scan found {len(blocks)} blocks.",
            "success": True,
            "data": result,
            "values": {"count": len(blocks)},
        }

    async def _vision(self) -> object:
        """Semantic environment context: biome, looking at, nearby blocks, entities."""
        assert self.service is not None
        state = await self.service.get_state()
        if not isinstance(state, dict) or not state.get("connected"):
            return {
                "text": "Minecraft bot not connected",
                "values": {"connected": False},
                "data": {},
            }

        # Perform a bounded scan for key blocks
        scan_result = await self.service.request(
            "scan",
            {
                "blocks": [
                    "oak_log",
                    "spruce_log",
                    "birch_log",
                    "jungle_log",
                    "acacia_log",
                    "dark_oak_log",
                    "stone",
                    "coal_ore",
                    "iron_ore",
                ],
                "radius": 16,
                "maxResults": 24,
            },
        )
        blocks = scan_result.get("blocks", []) if isinstance(scan_result, dict) else []

        # Extract position
        position = state.get("position")
        pos_str = "(unknown)"
        if position and isinstance(position, dict):
            x = position.get("x", 0)
            y = position.get("y", 0)
            z = position.get("z", 0)
            pos_str = f"({x:.1f}, {y:.1f}, {z:.1f})"

        # Extract biome
        biome = state.get("biome")
        biome_name = None
        if biome and isinstance(biome, dict) and "name" in biome:
            biome_name = biome["name"]

        # Extract what we're looking at
        looking_at = state.get("lookingAt")
        looking_text = "Looking at: (unknown)"
        if looking_at and isinstance(looking_at, dict):
            la_name = looking_at.get("name")
            la_pos = looking_at.get("position")
            if la_name and la_pos and isinstance(la_pos, dict):
                la_x = la_pos.get("x", 0)
                la_y = la_pos.get("y", 0)
                la_z = la_pos.get("z", 0)
                looking_text = f"Looking at: {la_name} at ({la_x}, {la_y}, {la_z})"

        # Entity count
        entities = state.get("nearbyEntities", [])
        entity_count = len(entities) if isinstance(entities, list) else 0

        return {
            "text": f"Biome: {biome_name or 'unknown'}\n"
            f"Position: {pos_str}\n"
            f"{looking_text}\n"
            f"NearbyEntities: {entity_count}\n"
            f"NearbyBlocksFound: {len(blocks)}",
            "values": {
                "connected": True,
                "biome": biome_name,
                "entityCount": entity_count,
                "blocksFound": len(blocks),
            },
            "data": {
                "biome": biome,
                "position": position,
                "lookingAt": looking_at,
                "nearbyEntities": entities,
                "nearbyBlocks": blocks,
            },
        }

    async def _waypoint_set(self, message: str) -> object:
        """Save current position as a named waypoint."""
        assert self.service is not None
        name = message.strip()
        if not name:
            return {"text": "Missing waypoint name", "success": False}

        state = await self.service.get_state()
        if not isinstance(state, dict) or not state.get("connected"):
            return {"text": "Bot not connected", "success": False}

        position = state.get("position")
        if not position or not isinstance(position, dict):
            return {"text": "No position available", "success": False}

        x = position.get("x", 0)
        y = position.get("y", 0)
        z = position.get("z", 0)

        wp = Waypoint(name=name, x=float(x), y=float(y), z=float(z))
        self.waypoints[name] = wp

        return {
            "text": f'Saved waypoint "{name}" at ({x:.1f}, {y:.1f}, {z:.1f}).',
            "success": True,
            "data": {
                "name": wp.name,
                "x": wp.x,
                "y": wp.y,
                "z": wp.z,
                "createdAt": wp.created_at.isoformat(),
            },
        }

    async def _waypoint_delete(self, message: str) -> object:
        """Delete a named waypoint."""
        name = message.strip()
        if not name:
            return {"text": "Missing waypoint name", "success": False}

        if name in self.waypoints:
            del self.waypoints[name]
            return {
                "text": f'Deleted waypoint "{name}".',
                "success": True,
                "values": {"deleted": True},
            }
        return {
            "text": f'No waypoint named "{name}".',
            "success": False,
            "values": {"deleted": False},
        }

    async def _waypoint_list(self, _message: str) -> object:
        """List all saved waypoints."""
        wp_list = list(self.waypoints.values())
        if not wp_list:
            return {
                "text": "No waypoints saved.",
                "success": True,
                "data": {"waypoints": []},
            }

        lines = [f"- {w.name}: ({w.x:.1f}, {w.y:.1f}, {w.z:.1f})" for w in wp_list]
        return {
            "text": "Waypoints:\n" + "\n".join(lines),
            "success": True,
            "data": {
                "waypoints": [
                    {
                        "name": w.name,
                        "x": w.x,
                        "y": w.y,
                        "z": w.z,
                        "createdAt": w.created_at.isoformat(),
                    }
                    for w in wp_list
                ],
            },
        }

    async def _waypoint_goto(self, message: str) -> object:
        """Navigate to a named waypoint."""
        assert self.service is not None
        name = message.strip()
        if not name:
            return {"text": "Missing waypoint name", "success": False}

        wp = self.waypoints.get(name)
        if not wp:
            return {"text": f'No waypoint named "{name}".', "success": False}

        await self.service.request("goto", {"x": wp.x, "y": wp.y, "z": wp.z})
        return {
            "text": f'Navigating to waypoint "{wp.name}" at ({wp.x:.1f}, {wp.y:.1f}, {wp.z:.1f}).',
            "success": True,
        }

    async def _waypoints_provider(self) -> object:
        """Provider that returns all saved waypoints."""
        wp_list = list(self.waypoints.values())
        if not wp_list:
            return {
                "text": "No waypoints saved.",
                "values": {"count": 0},
                "data": {"waypoints": []},
            }

        lines = [f"- {w.name}: ({w.x:.1f}, {w.y:.1f}, {w.z:.1f})" for w in wp_list]
        return {
            "text": "Waypoints:\n" + "\n".join(lines),
            "values": {"count": len(wp_list)},
            "data": {
                "waypoints": [
                    {
                        "name": w.name,
                        "x": w.x,
                        "y": w.y,
                        "z": w.z,
                        "createdAt": w.created_at.isoformat(),
                    }
                    for w in wp_list
                ],
            },
        }


def create_minecraft_plugin(config: MinecraftConfig | None = None) -> MinecraftPlugin:
    plugin = MinecraftPlugin(config=config or MinecraftConfig())
    return plugin
