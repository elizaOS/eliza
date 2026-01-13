from __future__ import annotations

import base64
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from .service import VisionService
from .types import VisionMode

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    agent_id: str

    def get_service(self, name: str) -> Any: ...

    async def create_memory(self, memory: dict, table: str) -> None: ...


class MemoryProtocol(Protocol):
    room_id: str | None
    world_id: str | None
    content: dict[str, Any]


ActionHandler = Callable[[RuntimeProtocol, MemoryProtocol, Any, Any, Callable | None], Any]


async def _save_execution_record(
    runtime: RuntimeProtocol,
    message: MemoryProtocol,
    thought: str,
    text: str,
    actions: list[str] | None = None,
    attachments: list[dict] | None = None,
) -> None:
    import secrets

    memory = {
        "id": secrets.token_hex(16),
        "content": {
            "text": text,
            "thought": thought,
            "actions": actions or ["VISION_ANALYSIS"],
            "attachments": attachments,
        },
        "entity_id": secrets.token_hex(16),
        "agent_id": runtime.agent_id,
        "room_id": message.room_id,
        "world_id": message.world_id,
        "created_at": int(time.time() * 1000),
    }
    await runtime.create_memory(memory, "messages")


class DescribeSceneAction:
    name = "DESCRIBE_SCENE"
    similes = ["ANALYZE_SCENE", "WHAT_DO_YOU_SEE", "VISION_CHECK", "LOOK_AROUND"]
    description = "Analyzes the current visual scene and provides a detailed description."
    enabled = True

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        if isinstance(vision_service, VisionService):
            return vision_service.is_active()
        return False

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> dict[str, Any]:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService) or not vision_service.is_active():
            thought = "Vision service is not available."
            text = "I cannot see anything right now. No camera is available."
            await _save_execution_record(runtime, message, thought, text, ["DESCRIBE_SCENE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["DESCRIBE_SCENE"]})
            return {
                "text": "Vision service unavailable",
                "values": {"success": False, "vision_available": False},
                "data": {"action_name": "DESCRIBE_SCENE", "error": "Vision service not available"},
            }

        try:
            scene = await vision_service.get_scene_description()
            camera_info = vision_service.get_camera_info()

            if not scene:
                thought = "Camera connected but no scene analyzed yet."
                text = f'Camera "{camera_info.name if camera_info else "unknown"}" connected, but no scenes analyzed.'
                await _save_execution_record(runtime, message, thought, text, ["DESCRIBE_SCENE"])
                if callback:
                    await callback(
                        {"thought": thought, "text": text, "actions": ["DESCRIBE_SCENE"]}
                    )
                return {
                    "text": "Camera connected but no scene analyzed",
                    "values": {"success": False, "vision_available": True, "scene_analyzed": False},
                    "data": {"action_name": "DESCRIBE_SCENE", "camera_info": camera_info},
                }

            people_count = len(scene.people)
            object_count = len(scene.objects)

            description = f"Looking through {camera_info.name if camera_info else 'the camera'}, {scene.description}"

            if people_count > 0:
                description += (
                    f"\n\nI can see {people_count} {'person' if people_count == 1 else 'people'}."
                )

            if object_count > 0:
                from collections import Counter

                type_counts = Counter(o.type for o in scene.objects)
                obj_descs = [f"{c} {t}{'s' if c > 1 else ''}" for t, c in type_counts.items()]
                description += f"\n\nObjects detected: {', '.join(obj_descs)}."

            thought = "Analyzed the visual scene."
            await _save_execution_record(runtime, message, thought, description, ["DESCRIBE_SCENE"])
            if callback:
                await callback(
                    {"thought": thought, "text": description, "actions": ["DESCRIBE_SCENE"]}
                )

            return {
                "text": description,
                "values": {
                    "success": True,
                    "vision_available": True,
                    "scene_analyzed": True,
                    "people_count": people_count,
                    "object_count": object_count,
                },
                "data": {
                    "action_name": "DESCRIBE_SCENE",
                    "scene": scene,
                    "camera_info": camera_info,
                },
            }

        except Exception as e:
            logger.error(f"[describeSceneAction] Error: {e}")
            thought = "An error occurred analyzing the scene."
            text = f"Error analyzing scene: {e}"
            await _save_execution_record(runtime, message, thought, text, ["DESCRIBE_SCENE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["DESCRIBE_SCENE"]})
            return {
                "text": "Error analyzing scene",
                "values": {"success": False, "vision_available": True, "error": True},
                "data": {"action_name": "DESCRIBE_SCENE", "error": str(e)},
            }


class CaptureImageAction:
    name = "CAPTURE_IMAGE"
    similes = ["TAKE_PHOTO", "SCREENSHOT", "CAPTURE_FRAME", "TAKE_PICTURE"]
    description = "Captures the current frame from the camera."
    enabled = False

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        if isinstance(vision_service, VisionService):
            return vision_service.is_active()
        return False

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> dict[str, Any]:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService) or not vision_service.is_active():
            thought = "Vision service is not available."
            text = "I cannot capture an image right now."
            await _save_execution_record(runtime, message, thought, text, ["CAPTURE_IMAGE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["CAPTURE_IMAGE"]})
            return {
                "text": "Vision service unavailable",
                "values": {"success": False, "vision_available": False},
                "data": {"action_name": "CAPTURE_IMAGE", "error": "Vision service not available"},
            }

        try:
            image_buffer = await vision_service.capture_image()
            camera_info = vision_service.get_camera_info()

            if not image_buffer:
                thought = "Failed to capture image."
                text = "I could not capture an image from the camera."
                await _save_execution_record(runtime, message, thought, text, ["CAPTURE_IMAGE"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["CAPTURE_IMAGE"]})
                return {
                    "text": "Failed to capture image",
                    "values": {
                        "success": False,
                        "vision_available": True,
                        "capture_success": False,
                    },
                    "data": {"action_name": "CAPTURE_IMAGE", "error": "Camera capture failed"},
                }

            import secrets
            from datetime import datetime

            attachment_id = secrets.token_hex(16)
            timestamp = datetime.now().isoformat()

            image_attachment = {
                "id": attachment_id,
                "title": f"Camera Capture - {timestamp}",
                "content_type": "IMAGE",
                "source": f"camera:{camera_info.name if camera_info else 'unknown'}",
                "url": f"data:image/jpeg;base64,{base64.b64encode(image_buffer).decode()}",
            }

            thought = (
                f'Captured an image from camera "{camera_info.name if camera_info else "unknown"}".'
            )
            text = f"I've captured an image from the camera at {timestamp}."

            await _save_execution_record(
                runtime, message, thought, text, ["CAPTURE_IMAGE"], [image_attachment]
            )
            if callback:
                await callback(
                    {
                        "thought": thought,
                        "text": text,
                        "actions": ["CAPTURE_IMAGE"],
                        "attachments": [image_attachment],
                    }
                )

            return {
                "text": text,
                "values": {
                    "success": True,
                    "vision_available": True,
                    "capture_success": True,
                    "camera_name": camera_info.name if camera_info else None,
                    "timestamp": timestamp,
                },
                "data": {
                    "action_name": "CAPTURE_IMAGE",
                    "image_attachment": image_attachment,
                    "camera_info": camera_info,
                    "timestamp": timestamp,
                },
            }

        except Exception as e:
            logger.error(f"[captureImageAction] Error: {e}")
            thought = "An error occurred capturing an image."
            text = f"Error capturing image: {e}"
            await _save_execution_record(runtime, message, thought, text, ["CAPTURE_IMAGE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["CAPTURE_IMAGE"]})
            return {
                "text": "Error capturing image",
                "values": {"success": False, "vision_available": True, "error": True},
                "data": {"action_name": "CAPTURE_IMAGE", "error": str(e)},
            }


class SetVisionModeAction:
    name = "SET_VISION_MODE"
    description = "Set the vision mode to OFF, CAMERA, SCREEN, or BOTH"
    similes = ["change vision to", "set vision mode", "switch to vision"]
    enabled = True

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        return vision_service is not None

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> None:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService):
            thought = "Vision service is not available."
            text = "I cannot change vision mode."
            await _save_execution_record(runtime, message, thought, text, ["SET_VISION_MODE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["SET_VISION_MODE"]})
            return

        try:
            message_text = message.content.get("text", "").lower()
            new_mode: VisionMode | None = None

            if "off" in message_text or "disable" in message_text:
                new_mode = VisionMode.OFF
            elif "both" in message_text:
                new_mode = VisionMode.BOTH
            elif "screen" in message_text:
                new_mode = VisionMode.SCREEN
            elif "camera" in message_text:
                new_mode = VisionMode.CAMERA

            if not new_mode:
                thought = "Could not determine vision mode."
                text = "Please specify the vision mode: OFF, CAMERA, SCREEN, or BOTH."
                await _save_execution_record(runtime, message, thought, text, ["SET_VISION_MODE"])
                if callback:
                    await callback(
                        {"thought": thought, "text": text, "actions": ["SET_VISION_MODE"]}
                    )
                return

            current_mode = vision_service.get_vision_mode()
            await vision_service.set_vision_mode(new_mode)

            thought = f"Changed vision mode from {current_mode.value} to {new_mode.value}."
            mode_texts = {
                VisionMode.OFF: "Vision has been disabled.",
                VisionMode.CAMERA: "Vision mode set to CAMERA only.",
                VisionMode.SCREEN: "Vision mode set to SCREEN only.",
                VisionMode.BOTH: "Vision mode set to BOTH.",
            }
            text = mode_texts[new_mode]

            await _save_execution_record(runtime, message, thought, text, ["SET_VISION_MODE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["SET_VISION_MODE"]})

        except Exception as e:
            logger.error(f"[setVisionModeAction] Error: {e}")
            thought = "An error occurred changing vision mode."
            text = f"Error changing vision mode: {e}"
            await _save_execution_record(runtime, message, thought, text, ["SET_VISION_MODE"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["SET_VISION_MODE"]})


class NameEntityAction:
    name = "NAME_ENTITY"
    description = "Assign a name to a person or object currently visible"
    similes = ["call the person", "name the person", "that person is"]
    enabled = True

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        if isinstance(vision_service, VisionService):
            return vision_service.is_active()
        return False

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> None:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService):
            thought = "Vision service is not available."
            text = "I cannot name entities."
            await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})
            return

        try:
            scene = await vision_service.get_scene_description()

            if not scene or not scene.people:
                thought = "No people visible to name."
                text = "I don't see any people in the current scene."
                await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})
                return

            # Extract name from message
            import re

            message_text = message.content.get("text", "")
            name_match = re.search(
                r"(?:named?|call(?:ed)?|is)\s+(\w+)", message_text, re.IGNORECASE
            )

            if not name_match:
                thought = "Could not extract name from message."
                text = "I couldn't understand what name to assign."
                await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})
                return

            name = name_match.group(1)
            entity_tracker = vision_service.get_entity_tracker()

            await entity_tracker.update_entities(scene.objects, scene.people, None, None)
            active_entities = entity_tracker.get_active_entities()
            people = [e for e in active_entities if e.entity_type == "person"]

            if not people:
                thought = "No tracked people found."
                text = "I can see someone but haven't established tracking yet."
                await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})
                return

            # Find the most prominent person (largest bounding box)
            target_person = max(people, key=lambda p: p.last_position.area())

            success = entity_tracker.assign_name_to_entity(target_person.id, name)

            if success:
                thought = f'Named entity "{name}".'
                text = f"I've identified the person as {name}."
                await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
                if callback:
                    await callback(
                        {
                            "thought": thought,
                            "text": text,
                            "actions": ["NAME_ENTITY"],
                            "data": {"entity_id": target_person.id, "name": name},
                        }
                    )
            else:
                thought = "Failed to assign name."
                text = "There was an error assigning the name."
                await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})

        except Exception as e:
            logger.error(f"[nameEntityAction] Error: {e}")
            thought = "Failed to name entity."
            text = f"Sorry, I couldn't name the entity: {e}"
            await _save_execution_record(runtime, message, thought, text, ["NAME_ENTITY"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["NAME_ENTITY"]})


class IdentifyPersonAction:
    name = "IDENTIFY_PERSON"
    description = "Identify a person in view if they have been seen before"
    similes = ["who is that", "who is the person", "identify the person"]
    enabled = False

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        if isinstance(vision_service, VisionService):
            return vision_service.is_active()
        return False

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> None:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService):
            thought = "Vision service is not available."
            text = "I cannot identify people."
            await _save_execution_record(runtime, message, thought, text, ["IDENTIFY_PERSON"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["IDENTIFY_PERSON"]})
            return

        try:
            scene = await vision_service.get_scene_description()

            if not scene or not scene.people:
                thought = "No people visible to identify."
                text = "I don't see any people in the current scene."
                await _save_execution_record(runtime, message, thought, text, ["IDENTIFY_PERSON"])
                if callback:
                    await callback(
                        {"thought": thought, "text": text, "actions": ["IDENTIFY_PERSON"]}
                    )
                return

            entity_tracker = vision_service.get_entity_tracker()
            await entity_tracker.update_entities(scene.objects, scene.people, None, None)
            active_entities = entity_tracker.get_active_entities()
            people = [e for e in active_entities if e.entity_type == "person"]

            if not people:
                thought = "No tracked people found."
                text = "I can see someone but I'm still processing their identity."
                await _save_execution_record(runtime, message, thought, text, ["IDENTIFY_PERSON"])
                if callback:
                    await callback(
                        {"thought": thought, "text": text, "actions": ["IDENTIFY_PERSON"]}
                    )
                return

            identifications = []
            recognized_count = 0
            unknown_count = 0

            for person in people:
                name = person.attributes.name
                duration = int(time.time() * 1000) - person.first_seen
                duration_str = (
                    f"{round(duration / 1000)} seconds"
                    if duration < 60000
                    else f"{round(duration / 60000)} minutes"
                )

                if name:
                    recognized_count += 1
                    identifications.append(
                        f"I can see {name}. They've been here for {duration_str}."
                    )
                else:
                    unknown_count += 1
                    identifications.append(
                        f"I see an unidentified person who has been here for {duration_str}."
                    )

            thought = f"Identified {recognized_count} known and {unknown_count} unknown people."
            text = " ".join(identifications)

            await _save_execution_record(runtime, message, thought, text, ["IDENTIFY_PERSON"])
            if callback:
                await callback(
                    {
                        "thought": thought,
                        "text": text,
                        "actions": ["IDENTIFY_PERSON"],
                        "data": {"identifications": people},
                    }
                )

        except Exception as e:
            logger.error(f"[identifyPersonAction] Error: {e}")
            thought = "Failed to identify people."
            text = f"Sorry, I couldn't identify people: {e}"
            await _save_execution_record(runtime, message, thought, text, ["IDENTIFY_PERSON"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["IDENTIFY_PERSON"]})


class TrackEntityAction:
    name = "TRACK_ENTITY"
    description = "Start tracking a specific person or object in view"
    similes = ["track the", "follow the", "keep an eye on"]
    enabled = False

    @staticmethod
    async def validate(runtime: RuntimeProtocol, *args, **kwargs) -> bool:
        """Validate if action can be executed"""
        vision_service = runtime.get_service("VISION")
        if isinstance(vision_service, VisionService):
            return vision_service.is_active()
        return False

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> None:
        """Execute the action"""
        vision_service = runtime.get_service("VISION")

        if not isinstance(vision_service, VisionService):
            thought = "Vision service is not available."
            text = "I cannot track entities."
            await _save_execution_record(runtime, message, thought, text, ["TRACK_ENTITY"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["TRACK_ENTITY"]})
            return

        try:
            scene = await vision_service.get_scene_description()

            if not scene:
                thought = "No scene available."
                text = "I need a moment to process the visual scene."
                await _save_execution_record(runtime, message, thought, text, ["TRACK_ENTITY"])
                if callback:
                    await callback({"thought": thought, "text": text, "actions": ["TRACK_ENTITY"]})
                return

            entity_tracker = vision_service.get_entity_tracker()
            await entity_tracker.update_entities(scene.objects, scene.people, None, None)
            stats = entity_tracker.get_statistics()

            thought = f"Tracking {stats['active_entities']} entities."
            text = (
                f"I'm now tracking {stats['active_entities']} entities "
                f"({stats['people']} people, {stats['objects']} objects)."
            )

            await _save_execution_record(runtime, message, thought, text, ["TRACK_ENTITY"])
            if callback:
                await callback(
                    {
                        "thought": thought,
                        "text": text,
                        "actions": ["TRACK_ENTITY"],
                        "data": {"entities": stats["active_entities"]},
                    }
                )

        except Exception as e:
            logger.error(f"[trackEntityAction] Error: {e}")
            thought = "Failed to track entities."
            text = f"Sorry, I couldn't track entities: {e}"
            await _save_execution_record(runtime, message, thought, text, ["TRACK_ENTITY"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["TRACK_ENTITY"]})


class KillAutonomousAction:
    name = "KILL_AUTONOMOUS"
    similes = ["STOP_AUTONOMOUS", "HALT_AUTONOMOUS", "KILL_AUTO_LOOP"]
    description = "Stops the autonomous agent loop for debugging purposes."
    enabled = False

    @staticmethod
    async def validate(*args, **kwargs) -> bool:
        return True

    @staticmethod
    async def handler(
        runtime: RuntimeProtocol,
        message: MemoryProtocol,
        state: Any = None,
        options: Any = None,
        callback: Callable | None = None,
    ) -> None:
        """Execute the action"""
        try:
            autonomous_service = runtime.get_service("AUTONOMOUS")

            if autonomous_service and hasattr(autonomous_service, "stop"):
                await autonomous_service.stop()  # type: ignore
                thought = "Successfully stopped the autonomous agent loop."
                text = "Autonomous loop has been killed."
            else:
                thought = "Autonomous service not found or already stopped."
                text = "No autonomous loop was running."

            await _save_execution_record(runtime, message, thought, text, ["KILL_AUTONOMOUS"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["KILL_AUTONOMOUS"]})

        except Exception as e:
            logger.error(f"[killAutonomousAction] Error: {e}")
            thought = "An error occurred stopping the autonomous loop."
            text = f"Error stopping autonomous loop: {e}"
            await _save_execution_record(runtime, message, thought, text, ["KILL_AUTONOMOUS"])
            if callback:
                await callback({"thought": thought, "text": text, "actions": ["KILL_AUTONOMOUS"]})


describe_scene_action = DescribeSceneAction()
capture_image_action = CaptureImageAction()
set_vision_mode_action = SetVisionModeAction()
name_entity_action = NameEntityAction()
identify_person_action = IdentifyPersonAction()
track_entity_action = TrackEntityAction()
kill_autonomous_action = KillAutonomousAction()
