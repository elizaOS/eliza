from __future__ import annotations

import asyncio
import logging
import os
import platform
import subprocess
import tempfile
import time
from io import BytesIO
from typing import Any, Protocol

from PIL import Image

from .entity_tracker import EntityTracker
from .ocr import OCRService
from .screen_capture import ScreenCaptureService
from .types import (
    BoundingBox,
    CameraInfo,
    DetectedObject,
    EnhancedSceneDescription,
    PersonInfo,
    SceneDescription,
    ScreenAnalysis,
    ScreenCapture,
    TileAnalysis,
    VisionConfig,
    VisionFrame,
    VisionMode,
)

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None: ...

    async def use_model(self, model_type: str, data: Any) -> Any: ...


class CameraDevice:
    def __init__(self, id: str, name: str, capture_fn):
        self.id = id
        self.name = name
        self._capture_fn = capture_fn

    async def capture(self) -> bytes:
        return await self._capture_fn()


class VisionService:
    SERVICE_TYPE = "VISION"

    def __init__(self, runtime: RuntimeProtocol | None = None):
        self._runtime = runtime
        self._config = self._parse_config(runtime)
        self._camera: CameraDevice | None = None
        self._last_frame: VisionFrame | None = None
        self._last_scene_description: SceneDescription | None = None
        self._frame_processing_task: asyncio.Task[None] | None = None
        self._screen_processing_task: asyncio.Task[None] | None = None
        self._is_processing = False
        self._is_processing_screen = False
        self._running = False

        world_id = runtime.get_setting("WORLD_ID") if runtime else "default-world"
        self._entity_tracker = EntityTracker(world_id or "default-world")
        self._screen_capture = ScreenCaptureService(self._config)
        self._ocr_service = OCRService()
        self._last_screen_capture: ScreenCapture | None = None
        self._last_enhanced_scene: EnhancedSceneDescription | None = None

        self._last_tf_update_time = 0
        self._last_vlm_update_time = 0
        self._last_tf_description = ""

        logger.info(f"[VisionService] Constructed with mode: {self._config.vision_mode}")

    def _parse_config(self, runtime: RuntimeProtocol | None) -> VisionConfig:
        if not runtime:
            return VisionConfig()

        def get_bool(key: str, default: bool) -> bool:
            val = runtime.get_setting(key)
            return val.lower() == "true" if val else default

        def get_int(key: str, default: int) -> int:
            val = runtime.get_setting(key)
            return int(val) if val else default

        vision_mode_str = runtime.get_setting("VISION_MODE")
        vision_mode = VisionMode.CAMERA
        if vision_mode_str:
            try:
                vision_mode = VisionMode(vision_mode_str.upper())
            except ValueError:
                pass

        return VisionConfig(
            camera_name=runtime.get_setting("CAMERA_NAME"),
            pixel_change_threshold=get_int("PIXEL_CHANGE_THRESHOLD", 50),
            enable_object_detection=get_bool("ENABLE_OBJECT_DETECTION", False),
            enable_pose_detection=get_bool("ENABLE_POSE_DETECTION", False),
            enable_face_recognition=get_bool("ENABLE_FACE_RECOGNITION", False),
            tf_update_interval=get_int("TF_UPDATE_INTERVAL", 1000),
            vlm_update_interval=get_int("VLM_UPDATE_INTERVAL", 10000),
            vision_mode=vision_mode,
            screen_capture_interval=get_int("SCREEN_CAPTURE_INTERVAL", 2000),
            ocr_enabled=get_bool("OCR_ENABLED", True),
        )

    @classmethod
    async def start(cls, runtime: RuntimeProtocol) -> VisionService:
        service = cls(runtime)
        await service.initialize()
        return service

    async def initialize(self) -> None:
        try:
            if self._config.vision_mode in (VisionMode.SCREEN, VisionMode.BOTH):
                await self._initialize_screen_vision()

            if self._config.vision_mode in (VisionMode.CAMERA, VisionMode.BOTH):
                await self._initialize_camera_vision()

            self._start_processing()
        except Exception as e:
            logger.error(f"[VisionService] Failed to initialize: {e}")

    async def _initialize_screen_vision(self) -> None:
        try:
            logger.info("[VisionService] Initializing screen vision...")

            if self._config.ocr_enabled:
                await self._ocr_service.initialize()

            screen_info = await self._screen_capture.get_screen_info()
            if screen_info:
                logger.info(
                    f"[VisionService] Screen resolution: "
                    f"{screen_info['width']}x{screen_info['height']}"
                )

            logger.info("[VisionService] Screen vision initialized")
        except Exception as e:
            logger.error(f"[VisionService] Failed to initialize screen vision: {e}")

    async def _initialize_camera_vision(self) -> None:
        tool_check = await self._check_camera_tools()
        if not tool_check["available"]:
            system = platform.system()
            tool_name = (
                "imagesnap" if system == "Darwin" else "fswebcam" if system == "Linux" else "ffmpeg"
            )
            logger.warning(f"[VisionService] Camera capture tool '{tool_name}' not found")
            return

        camera = await self._find_camera()
        if camera:
            self._camera = camera
            logger.info(f"[VisionService] Connected to camera: {camera.name}")
        else:
            logger.warning("[VisionService] No suitable camera found")

    async def _check_camera_tools(self) -> dict[str, Any]:
        system = platform.system()

        try:
            if system == "Darwin":
                process = await asyncio.create_subprocess_shell(
                    "which imagesnap",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                await process.communicate()
                if process.returncode == 0:
                    return {"available": True, "tool": "imagesnap"}

            elif system == "Linux":
                process = await asyncio.create_subprocess_shell(
                    "which fswebcam",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                await process.communicate()
                if process.returncode == 0:
                    return {"available": True, "tool": "fswebcam"}

            elif system == "Windows":
                process = await asyncio.create_subprocess_shell(
                    "where ffmpeg",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                await process.communicate()
                if process.returncode == 0:
                    return {"available": True, "tool": "ffmpeg"}

        except Exception:
            pass

        return {"available": False, "tool": "none"}

    def _start_processing(self) -> None:
        self._running = True

        if self._config.vision_mode in (VisionMode.CAMERA, VisionMode.BOTH) and self._camera:
            self._frame_processing_task = asyncio.create_task(self._frame_processing_loop())

        if self._config.vision_mode in (VisionMode.SCREEN, VisionMode.BOTH):
            self._screen_processing_task = asyncio.create_task(self._screen_processing_loop())

    async def _frame_processing_loop(self) -> None:
        logger.debug("[VisionService] Started frame processing loop")
        while self._running:
            if not self._is_processing and self._camera:
                self._is_processing = True
                try:
                    await self._capture_and_process_frame()
                except Exception as e:
                    logger.error(f"[VisionService] Frame processing error: {e}")
                self._is_processing = False
            await asyncio.sleep(self._config.update_interval / 1000)

    async def _capture_and_process_frame(self) -> None:
        if not self._camera:
            return

        try:
            frame_data = await self._camera.capture()
            if not frame_data:
                return

            frame = await self._process_frame_data(frame_data)
            if not frame or frame.width == 0 or frame.height == 0:
                return

            change_percentage = 100.0
            if self._last_frame:
                change_percentage = await self._calculate_pixel_change(self._last_frame, frame)

            await self._update_scene_description(frame, change_percentage)
            self._last_frame = frame

        except Exception as e:
            logger.error(f"[VisionService] Error capturing frame: {e}")

    async def _process_frame_data(self, data: bytes) -> VisionFrame:
        if not data:
            raise ValueError("Empty frame data")

        img = Image.open(BytesIO(data))
        img = img.convert("RGBA")

        return VisionFrame(
            timestamp=int(time.time() * 1000),
            width=img.width,
            height=img.height,
            data=img.tobytes(),
            format="rgba",
        )

    async def _calculate_pixel_change(self, frame1: VisionFrame, frame2: VisionFrame) -> float:
        if frame1.width != frame2.width or frame1.height != frame2.height:
            return 100.0

        changed_pixels = 0
        total_pixels = frame1.width * frame1.height
        threshold = 30

        for i in range(0, len(frame1.data), 4):
            if i + 2 < len(frame1.data) and i + 2 < len(frame2.data):
                diff = (
                    abs(frame1.data[i] - frame2.data[i])
                    + abs(frame1.data[i + 1] - frame2.data[i + 1])
                    + abs(frame1.data[i + 2] - frame2.data[i + 2])
                )
                if diff > threshold:
                    changed_pixels += 1

        return (changed_pixels / total_pixels) * 100

    async def _update_scene_description(self, frame: VisionFrame, change_percentage: float) -> None:
        try:
            current_time = int(time.time() * 1000)

            img = Image.frombytes("RGBA", (frame.width, frame.height), frame.data).convert("RGB")
            buffer = BytesIO()
            img.save(buffer, format="JPEG")
            jpeg_data = buffer.getvalue()
            import base64

            base64_image = base64.b64encode(jpeg_data).decode()
            image_url = f"data:image/jpeg;base64,{base64_image}"

            time_since_vlm = current_time - self._last_vlm_update_time
            should_update_vlm = (
                time_since_vlm >= self._config.vlm_update_interval
                or change_percentage >= self._config.vlm_change_threshold
            )

            description = self._last_tf_description

            if should_update_vlm:
                description = await self._describe_scene_with_vlm(image_url)
                self._last_vlm_update_time = current_time
                self._last_tf_description = description

            detected_objects = await self._detect_motion_objects(frame)
            people = await self._detect_people_from_motion(frame, detected_objects)

            await self._entity_tracker.update_entities(
                detected_objects, people, None, self._runtime
            )

            self._last_scene_description = SceneDescription(
                timestamp=frame.timestamp,
                description=description,
                objects=detected_objects,
                people=people,
                scene_changed=should_update_vlm,
                change_percentage=change_percentage,
            )

        except Exception as e:
            logger.error(f"[VisionService] Failed to update scene description: {e}")

    async def _describe_scene_with_vlm(self, image_url: str) -> str:
        try:
            if self._runtime:
                result = await self._runtime.use_model("IMAGE_DESCRIPTION", image_url)
                if isinstance(result, dict) and "description" in result:
                    return str(result["description"])
                elif isinstance(result, str):
                    return result
            return "Visual scene captured"
        except Exception as e:
            logger.error(f"[VisionService] VLM description failed: {e}")
            return "Unable to describe scene"

    async def _detect_motion_objects(self, frame: VisionFrame) -> list[DetectedObject]:
        if not self._last_frame:
            return []

        objects: list[DetectedObject] = []
        block_size = 64
        motion_threshold = 50

        for y in range(0, frame.height - block_size, block_size // 2):
            for x in range(0, frame.width - block_size, block_size // 2):
                block_motion = 0
                pixel_count = 0

                for by in range(0, block_size, 2):
                    for bx in range(0, block_size, 2):
                        px = x + bx
                        py = y + by
                        idx = (py * frame.width + px) * 4

                        if idx + 2 < len(frame.data) and idx + 2 < len(self._last_frame.data):
                            diff = (
                                abs(frame.data[idx] - self._last_frame.data[idx])
                                + abs(frame.data[idx + 1] - self._last_frame.data[idx + 1])
                                + abs(frame.data[idx + 2] - self._last_frame.data[idx + 2])
                            )
                            if diff > motion_threshold:
                                block_motion += 1
                            pixel_count += 1

                if pixel_count > 0:
                    motion_pct = (block_motion / pixel_count) * 100
                    if motion_pct > 30:
                        objects.append(
                            DetectedObject(
                                id=f"motion-{x}-{y}-{frame.timestamp}",
                                type="motion-object",
                                confidence=min(motion_pct / 100, 1.0),
                                bounding_box=BoundingBox(
                                    x=x, y=y, width=block_size, height=block_size
                                ),
                            )
                        )

        return self._merge_adjacent_objects(objects)

    def _merge_adjacent_objects(self, objects: list[DetectedObject]) -> list[DetectedObject]:
        if not objects:
            return []

        merged: list[DetectedObject] = []
        used: set[int] = set()
        merge_distance = 80

        for i, obj in enumerate(objects):
            if i in used:
                continue

            cluster = [obj]
            used.add(i)

            found_new = True
            while found_new:
                found_new = False
                for j, other in enumerate(objects):
                    if j in used:
                        continue

                    for c_obj in cluster:
                        is_adjacent = (
                            abs(c_obj.bounding_box.x - other.bounding_box.x) <= merge_distance
                            and abs(c_obj.bounding_box.y - other.bounding_box.y) <= merge_distance
                        )
                        if is_adjacent:
                            cluster.append(other)
                            used.add(j)
                            found_new = True
                            break

            if cluster:
                min_x = min(o.bounding_box.x for o in cluster)
                min_y = min(o.bounding_box.y for o in cluster)
                max_x = max(o.bounding_box.x + o.bounding_box.width for o in cluster)
                max_y = max(o.bounding_box.y + o.bounding_box.height for o in cluster)
                avg_conf = sum(o.confidence for o in cluster) / len(cluster)

                merged.append(
                    DetectedObject(
                        id=f"merged-{min_x}-{min_y}-{int(time.time() * 1000)}",
                        type=self._classify_object_by_size(max_x - min_x, max_y - min_y),
                        confidence=avg_conf,
                        bounding_box=BoundingBox(
                            x=min_x, y=min_y, width=max_x - min_x, height=max_y - min_y
                        ),
                    )
                )

        return [o for o in merged if o.bounding_box.area() > 2000]

    def _classify_object_by_size(self, width: float, height: float) -> str:
        area = width * height
        aspect = width / height if height > 0 else 0

        if area > 30000 and 0.4 < aspect < 0.8:
            return "person-candidate"
        elif area > 20000:
            return "large-object"
        elif area > 8000:
            return "medium-object"
        return "small-object"

    async def _detect_people_from_motion(
        self, frame: VisionFrame, objects: list[DetectedObject]
    ) -> list[PersonInfo]:
        people: list[PersonInfo] = []
        candidates = [o for o in objects if o.type == "person-candidate"]

        for i, candidate in enumerate(candidates):
            box = candidate.bounding_box
            aspect = box.width / box.height if box.height > 0 else 0

            if aspect < 0.6:
                pose = "standing"
            elif aspect > 1.2:
                pose = "lying"
            else:
                pose = "sitting"

            people.append(
                PersonInfo(
                    id=f"person-{i}-{frame.timestamp}",
                    confidence=candidate.confidence,
                    pose=pose,  # type: ignore
                    facing="camera",
                    bounding_box=box,
                )
            )

        return people

    async def _screen_processing_loop(self) -> None:
        logger.debug("[VisionService] Started screen processing loop")
        while self._running:
            if not self._is_processing_screen:
                self._is_processing_screen = True
                try:
                    await self._capture_and_process_screen()
                except Exception as e:
                    logger.error(f"[VisionService] Screen processing error: {e}")
                self._is_processing_screen = False
            await asyncio.sleep(self._config.screen_capture_interval / 1000)

    async def _capture_and_process_screen(self) -> None:
        """Capture and process screen"""
        try:
            capture = await self._screen_capture.capture_screen()
            self._last_screen_capture = capture

            active_tile = self._screen_capture.get_active_tile()
            if active_tile and active_tile.data and self._config.ocr_enabled:
                ocr_result = await self._ocr_service.extract_from_tile(active_tile)
                active_tile.analysis = TileAnalysis(
                    timestamp=int(time.time() * 1000),
                    ocr=ocr_result,
                    text=ocr_result.full_text,
                )

            await self._update_enhanced_scene_description()

        except Exception as e:
            logger.error(f"[VisionService] Error capturing screen: {e}")

    async def _update_enhanced_scene_description(self) -> None:
        if not self._last_screen_capture:
            return

        base_scene = self._last_scene_description or SceneDescription(
            timestamp=int(time.time() * 1000),
            description="",
            objects=[],
            people=[],
            scene_changed=False,
            change_percentage=0,
        )

        self._last_enhanced_scene = EnhancedSceneDescription(
            timestamp=base_scene.timestamp,
            description=base_scene.description,
            objects=base_scene.objects,
            people=base_scene.people,
            scene_changed=base_scene.scene_changed,
            change_percentage=base_scene.change_percentage,
            screen_capture=self._last_screen_capture,
            screen_analysis=ScreenAnalysis(
                grid_summary=f"Screen: {len(self._last_screen_capture.tiles)} tiles",
                active_tile=self._screen_capture.get_active_tile().analysis
                if self._screen_capture.get_active_tile()
                else None,
            ),
        )

    async def get_current_frame(self) -> VisionFrame | None:
        return self._last_frame

    async def get_scene_description(self) -> SceneDescription | None:
        return self._last_scene_description

    async def get_enhanced_scene_description(
        self,
    ) -> EnhancedSceneDescription | SceneDescription | None:
        return self._last_enhanced_scene or self._last_scene_description

    async def get_screen_capture(self) -> ScreenCapture | None:
        """Get the last screen capture"""
        return self._last_screen_capture

    def get_vision_mode(self) -> VisionMode:
        return self._config.vision_mode

    async def set_vision_mode(self, mode: VisionMode) -> None:
        """Set vision mode"""
        logger.info(f"[VisionService] Changing vision mode to {mode}")
        await self._stop_processing()
        self._config.vision_mode = mode

        if mode == VisionMode.OFF:
            logger.info("[VisionService] Vision disabled")
            return

        if mode in (VisionMode.CAMERA, VisionMode.BOTH) and not self._camera:
            await self._initialize_camera_vision()

        if mode in (VisionMode.SCREEN, VisionMode.BOTH):
            await self._initialize_screen_vision()

        self._start_processing()

    async def _stop_processing(self) -> None:
        self._running = False

        if self._frame_processing_task:
            self._frame_processing_task.cancel()
            try:
                await self._frame_processing_task
            except asyncio.CancelledError:
                pass
            self._frame_processing_task = None

        if self._screen_processing_task:
            self._screen_processing_task.cancel()
            try:
                await self._screen_processing_task
            except asyncio.CancelledError:
                pass
            self._screen_processing_task = None

    def get_camera_info(self) -> CameraInfo | None:
        if not self._camera:
            return None
        return CameraInfo(id=self._camera.id, name=self._camera.name, connected=True)

    def is_active(self) -> bool:
        return self._camera is not None and self._running

    def get_entity_tracker(self) -> EntityTracker:
        return self._entity_tracker

    async def capture_image(self) -> bytes | None:
        if not self._camera:
            logger.warning("[VisionService] No camera available")
            return None
        try:
            return await self._camera.capture()
        except Exception as e:
            logger.error(f"[VisionService] Failed to capture image: {e}")
            return None

    async def stop(self) -> None:
        logger.info("[VisionService] Stopping vision service...")
        await self._stop_processing()
        await self._ocr_service.dispose()
        self._camera = None
        self._last_frame = None
        self._last_scene_description = None
        self._last_screen_capture = None
        self._last_enhanced_scene = None
        logger.info("[VisionService] Stopped.")

    async def _find_camera(self) -> CameraDevice | None:
        try:
            cameras = await self._list_cameras()
            if not cameras:
                logger.warning("[VisionService] No cameras detected")
                return None

            if self._config.camera_name:
                search_name = self._config.camera_name.lower()
                for cam in cameras:
                    if search_name in cam.name.lower():
                        return self._create_camera_device(cam)
                logger.warning(f"[VisionService] Camera '{self._config.camera_name}' not found")

            return self._create_camera_device(cameras[0])

        except Exception as e:
            logger.error(f"[VisionService] Error finding camera: {e}")
            return None

    async def _list_cameras(self) -> list[CameraInfo]:
        """List available cameras"""
        system = platform.system()
        cameras: list[CameraInfo] = []

        try:
            if system == "Darwin":
                process = await asyncio.create_subprocess_exec(
                    "system_profiler",
                    "SPCameraDataType",
                    "-json",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await process.communicate()
                import json

                data = json.loads(stdout)
                if data.get("SPCameraDataType"):
                    for cam in data["SPCameraDataType"]:
                        cameras.append(
                            CameraInfo(
                                id=cam.get("unique_id", cam.get("_name", "")),
                                name=cam.get("_name", "Unknown"),
                                connected=True,
                            )
                        )

            elif system == "Linux":
                process = await asyncio.create_subprocess_exec(
                    "v4l2-ctl",
                    "--list-devices",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await process.communicate()
                lines = stdout.decode().split("\n")
                current_name = ""
                for line in lines:
                    if line and not line.startswith("\t"):
                        current_name = line.replace(":", "").strip()
                    elif line.strip().startswith("/dev/video"):
                        device_id = line.strip().replace("/dev/video", "")
                        cameras.append(CameraInfo(id=device_id, name=current_name, connected=True))

            elif system == "Windows":
                process = await asyncio.create_subprocess_shell(
                    'powershell -Command "Get-PnpDevice -Class Camera | '
                    'Select-Object FriendlyName, InstanceId | ConvertTo-Json"',
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await process.communicate()
                import json

                devices = json.loads(stdout)
                if isinstance(devices, list):
                    for d in devices:
                        cameras.append(
                            CameraInfo(
                                id=d.get("InstanceId", ""),
                                name=d.get("FriendlyName", "Unknown"),
                                connected=True,
                            )
                        )

        except Exception as e:
            logger.error(f"[VisionService] Error listing cameras: {e}")

        return cameras

    def _create_camera_device(self, info: CameraInfo) -> CameraDevice:
        system = platform.system()

        async def capture() -> bytes:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
                temp_file = f.name

            try:
                if system == "Darwin":
                    process = await asyncio.create_subprocess_exec(
                        "imagesnap",
                        "-d",
                        info.name,
                        temp_file,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    await process.communicate()

                elif system == "Linux":
                    process = await asyncio.create_subprocess_exec(
                        "fswebcam",
                        "-d",
                        f"/dev/video{info.id}",
                        "-r",
                        "1280x720",
                        "--jpeg",
                        "85",
                        temp_file,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    await process.communicate()

                elif system == "Windows":
                    process = await asyncio.create_subprocess_shell(
                        f'ffmpeg -f dshow -i video="{info.name}" '
                        f'-frames:v 1 -q:v 2 "{temp_file}" -y',
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    await process.communicate()

                with open(temp_file, "rb") as f:
                    return f.read()

            finally:
                try:
                    os.unlink(temp_file)
                except Exception:
                    pass

        return CameraDevice(id=info.id, name=info.name, capture_fn=capture)
