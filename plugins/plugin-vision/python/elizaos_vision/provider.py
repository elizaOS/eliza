from __future__ import annotations

import logging
from typing import Any, Protocol

from .service import VisionService
from .types import VisionMode

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    def get_service(self, name: str) -> Any: ...


class MemoryProtocol(Protocol):
    """Protocol for message memory"""

    world_id: str | None


class VisionProvider:
    name = "VISION_PERCEPTION"
    description = (
        "Provides current visual perception data including scene description, "
        "detected objects, people, and entity tracking."
    )
    position = 99
    dynamic = False

    @staticmethod
    async def get(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any,
    ) -> dict[str, Any]:
        vision_service = runtime.get_service("VISION")

        if not vision_service or not isinstance(vision_service, VisionService):
            logger.warning("[visionProvider] VisionService not found.")
            return {
                "values": {
                    "vision_available": False,
                    "scene_description": "Vision service is not available.",
                    "camera_status": "No camera connected",
                },
                "text": "# Visual Perception\n\nVision service is not available.",
                "data": {"has_vision": False},
            }

        scene_description = (
            await vision_service.get_enhanced_scene_description()
            or await vision_service.get_scene_description()
        )
        camera_info = vision_service.get_camera_info()
        is_active = vision_service.is_active()
        vision_mode = vision_service.get_vision_mode()
        screen_capture = await vision_service.get_screen_capture()

        entity_tracker = vision_service.get_entity_tracker()
        entity_data = None

        if scene_description and entity_tracker:
            await entity_tracker.update_entities(
                scene_description.objects,
                scene_description.people,
                None,
                None,
            )

            active_entities = entity_tracker.get_active_entities()
            recently_left = entity_tracker.get_recently_left()
            stats = entity_tracker.get_statistics()

            import time

            current_time = int(time.time() * 1000)

            entity_data = {
                "active_entities": [
                    {
                        "id": e.id,
                        "type": e.entity_type,
                        "name": e.attributes.name,
                        "first_seen": e.first_seen,
                        "duration": current_time - e.first_seen,
                        "position": e.last_position,
                        "attributes": e.attributes,
                    }
                    for e in active_entities
                ],
                "recently_left": [
                    {
                        "id": entity.id,
                        "name": entity.attributes.name,
                        "left_at": left_at,
                        "time_ago": current_time - left_at,
                    }
                    for entity, left_at in recently_left
                ],
                "statistics": stats,
            }

        perception_text = ""
        values: dict[str, Any] = {}
        data: dict[str, Any] = {}

        if not is_active:
            perception_text = f"Vision mode: {vision_mode.value}\n"
            if vision_mode == VisionMode.OFF:
                perception_text += "Vision is disabled."
            else:
                perception_text += "Vision service is initializing..."

            values = {
                "vision_available": False,
                "vision_mode": vision_mode.value,
                "scene_description": "Vision not active",
                "camera_status": (
                    f'Camera "{camera_info.name}" detected but not active'
                    if camera_info
                    else "No camera"
                ),
            }
        else:
            perception_text = f"Vision mode: {vision_mode.value}\n\n"

            if vision_mode in (VisionMode.CAMERA, VisionMode.BOTH) and scene_description:
                import time

                age_seconds = (int(time.time() * 1000) - scene_description.timestamp) / 1000
                seconds_ago = round(age_seconds)

                perception_text += (
                    f"Camera view ({seconds_ago}s ago):\n{scene_description.description}"
                )

                if scene_description.people:
                    perception_text += f"\n\nPeople detected: {len(scene_description.people)}"
                    poses = [p.pose for p in scene_description.people if p.pose != "unknown"]
                    if poses:
                        from collections import Counter

                        pose_counts = Counter(poses)
                        perception_text += (
                            f"\n  Poses: {', '.join(f'{c} {p}' for p, c in pose_counts.items())}"
                        )

                if scene_description.objects:
                    object_types = list({o.type for o in scene_description.objects})
                    perception_text += f"\n\nObjects detected: {', '.join(object_types)}"

                if scene_description.scene_changed:
                    perception_text += (
                        f"\n\nScene change: {scene_description.change_percentage:.1f}% "
                        "of pixels changed"
                    )

                if entity_data:
                    if entity_data["active_entities"]:
                        perception_text += "\n\nCurrently tracking:"
                        for entity in entity_data["active_entities"]:
                            name = entity["name"] or f"Unknown {entity['type']}"
                            duration = entity["duration"]
                            duration_str = (
                                f"{round(duration / 1000)}s"
                                if duration < 60000
                                else f"{round(duration / 60000)}m"
                            )
                            perception_text += f"\n- {name} (present for {duration_str})"

                    if entity_data["recently_left"]:
                        perception_text += "\n\nRecently left:"
                        for departed in entity_data["recently_left"]:
                            name = departed["name"] or "Unknown person"
                            time_ago = departed["time_ago"]
                            time_str = (
                                f"{round(time_ago / 1000)}s ago"
                                if time_ago < 60000
                                else f"{round(time_ago / 60000)}m ago"
                            )
                            perception_text += f"\n- {name} left {time_str}"

            if vision_mode in (VisionMode.SCREEN, VisionMode.BOTH) and screen_capture:
                import time

                screen_age = (int(time.time() * 1000) - screen_capture.timestamp) / 1000
                screen_seconds_ago = round(screen_age)

                if vision_mode == VisionMode.BOTH:
                    perception_text += "\n\n---\n\n"

                perception_text += f"Screen capture ({screen_seconds_ago}s ago):\n"
                perception_text += f"Resolution: {screen_capture.width}x{screen_capture.height}\n"

            values = {
                "vision_available": True,
                "vision_mode": vision_mode.value,
                "scene_description": (
                    scene_description.description if scene_description else "Processing..."
                ),
                "camera_status": (
                    f"Connected to {camera_info.name}" if camera_info else "No camera"
                ),
                "camera_id": camera_info.id if camera_info else None,
                "people_count": len(scene_description.people) if scene_description else 0,
                "object_count": (len(scene_description.objects) if scene_description else 0),
                "scene_age": (
                    round((int(time.time() * 1000) - scene_description.timestamp) / 1000)
                    if scene_description
                    else None
                ),
                "last_change": (
                    scene_description.change_percentage
                    if scene_description and scene_description.scene_changed
                    else 0
                ),
                "has_screen_capture": screen_capture is not None,
                "screen_resolution": (
                    f"{screen_capture.width}x{screen_capture.height}" if screen_capture else None
                ),
                "active_entities": (entity_data["active_entities"] if entity_data else []),
                "recently_left": entity_data["recently_left"] if entity_data else [],
                "entity_statistics": (entity_data["statistics"] if entity_data else None),
            }

            data = {
                "objects": scene_description.objects if scene_description else [],
                "people": scene_description.people if scene_description else [],
                "screen_capture": screen_capture,
                "tracked_entities": (entity_data["active_entities"] if entity_data else []),
                "world_state": entity_data,
            }

        return {
            "values": values,
            "text": f"# Visual Perception\n\n{perception_text}",
            "data": data,
        }
