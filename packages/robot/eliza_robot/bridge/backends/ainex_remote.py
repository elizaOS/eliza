"""Remote AiNex backend over rosbridge_suite.

Uses `roslibpy` (pure-Python) to drive a physical Hiwonder AiNex that is
publishing the ainex_ros1 stack on a remote host. No `rospy` or ROS
runtime is required on the dev box — only a TCP path to the robot's
`rosbridge_websocket` (default 9090).

Maps the unified bridge envelope protocol to the same topics/services
that `ros_backend.py` uses with `rospy`. Behaviour is byte-identical
from the agent's perspective; only the transport differs.

Topics used:
  /app/set_walking_param            (ainex_interfaces/AppWalkingParam)
  /app/set_action                   (std_msgs/String)
  /head_pan_controller/command      (ainex_interfaces/HeadState)
  /head_tilt_controller/command     (ainex_interfaces/HeadState)
  /ros_robot_controller/bus_servo/set_position
                                    (ros_robot_controller/SetBusServosPosition)
  /walking/is_walking               (std_msgs/Bool)         [in]
  /ros_robot_controller/battery     (std_msgs/UInt16)       [in]
  /imu                              (sensor_msgs/Imu)       [in]
  /camera/image_raw/compressed      (sensor_msgs/CompressedImage) [in]

Services:
  /walking/command                  (ainex_interfaces/SetWalkingCommand)
"""

from __future__ import annotations

import asyncio
import base64
import math
import threading
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import (
    CommandEnvelope,
    EventEnvelope,
    ResponseEnvelope,
    utc_now_iso,
)
from eliza_robot.bridge.types import JsonDict


@dataclass
class _RemoteState:
    is_walking: bool = False
    battery_mv: int = 0
    imu_roll: float = 0.0
    imu_pitch: float = 0.0
    walk_x: float = 0.0
    walk_y: float = 0.0
    walk_yaw: float = 0.0
    walk_speed: int = 0
    walk_height: float = 0.036
    head_pan: float = 0.0
    head_tilt: float = 0.0
    joint_positions: dict[str, float] = field(default_factory=dict)
    last_camera_jpeg: bytes | None = None


class AinexRemoteBackend(BridgeBackend):
    """`BridgeBackend` that drives a physical AiNex over rosbridge_suite."""

    def __init__(
        self,
        host: str = "192.168.1.218",
        port: int = 9090,
        connect_timeout: float = 5.0,
    ) -> None:
        self._host = host
        self._port = port
        self._connect_timeout = connect_timeout
        self._state = _RemoteState()
        self._lock = threading.Lock()
        # roslibpy Ros + Topic/Service handles populated in connect()
        self._ros: Any = None
        self._walk_param: Any = None
        self._action_pub: Any = None
        self._head_pan_pub: Any = None
        self._head_tilt_pub: Any = None
        self._servo_pub: Any = None
        self._walking_cmd_srv: Any = None
        # Subscribers
        self._sub_walking: Any = None
        self._sub_battery: Any = None
        self._sub_imu: Any = None
        self._sub_camera: Any = None

    @property
    def backend_name(self) -> str:
        return "ainex_remote"

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_snapshot": True,
            "camera_stream_passthrough": True,
            "remote_rosbridge": True,
            "host": f"{self._host}:{self._port}",
        }

    async def connect(self) -> None:
        import roslibpy

        self._ros = roslibpy.Ros(host=self._host, port=self._port)
        self._ros.run(timeout=self._connect_timeout)
        if not self._ros.is_connected:
            raise RuntimeError(
                f"could not reach rosbridge at ws://{self._host}:{self._port}"
            )

        # Publishers (advertise once so the rosbridge_suite spawns the topic).
        self._walk_param = roslibpy.Topic(
            self._ros, "/app/set_walking_param", "ainex_interfaces/AppWalkingParam"
        )
        self._walk_param.advertise()
        self._action_pub = roslibpy.Topic(
            self._ros, "/app/set_action", "std_msgs/String"
        )
        self._action_pub.advertise()
        self._head_pan_pub = roslibpy.Topic(
            self._ros, "/head_pan_controller/command", "ainex_interfaces/HeadState"
        )
        self._head_pan_pub.advertise()
        self._head_tilt_pub = roslibpy.Topic(
            self._ros, "/head_tilt_controller/command", "ainex_interfaces/HeadState"
        )
        self._head_tilt_pub.advertise()
        self._servo_pub = roslibpy.Topic(
            self._ros,
            "/ros_robot_controller/bus_servo/set_position",
            "ros_robot_controller/SetBusServosPosition",
        )
        self._servo_pub.advertise()
        # Service handles.
        self._walking_cmd_srv = roslibpy.Service(
            self._ros, "/walking/command", "ainex_interfaces/SetWalkingCommand"
        )
        self._servo_pos_srv = roslibpy.Service(
            self._ros,
            "/ros_robot_controller/bus_servo/get_position",
            "ros_robot_controller/GetBusServosPosition",
        )

        # Subscribers — store on _state under a lock.
        self._sub_walking = roslibpy.Topic(
            self._ros, "/walking/is_walking", "std_msgs/Bool"
        )
        self._sub_walking.subscribe(self._on_is_walking)
        self._sub_battery = roslibpy.Topic(
            self._ros, "/ros_robot_controller/battery", "std_msgs/UInt16"
        )
        self._sub_battery.subscribe(self._on_battery)
        self._sub_imu = roslibpy.Topic(self._ros, "/imu", "sensor_msgs/Imu")
        self._sub_imu.subscribe(self._on_imu)
        self._sub_camera = roslibpy.Topic(
            self._ros,
            "/camera/image_raw/compressed",
            "sensor_msgs/CompressedImage",
            queue_length=1,
        )
        self._sub_camera.subscribe(self._on_camera)

    async def shutdown(self) -> None:
        if self._ros is None:
            return
        try:
            for t in (
                self._walk_param,
                self._action_pub,
                self._head_pan_pub,
                self._head_tilt_pub,
                self._servo_pub,
            ):
                if t is not None:
                    try:
                        t.unadvertise()
                    except Exception:
                        pass
            for s in (
                self._sub_walking,
                self._sub_battery,
                self._sub_imu,
                self._sub_camera,
            ):
                if s is not None:
                    try:
                        s.unsubscribe()
                    except Exception:
                        pass
            self._ros.terminate()
        finally:
            self._ros = None

    # ------------------------------------------------------------------
    # Telemetry callbacks (run on roslibpy's twisted thread)
    # ------------------------------------------------------------------
    def _on_is_walking(self, msg: JsonDict) -> None:
        with self._lock:
            self._state.is_walking = bool(msg.get("data", False))

    def _on_battery(self, msg: JsonDict) -> None:
        with self._lock:
            self._state.battery_mv = int(msg.get("data", 0))

    def _on_imu(self, msg: JsonDict) -> None:
        orient = msg.get("orientation") or {}
        x = float(orient.get("x", 0.0))
        y = float(orient.get("y", 0.0))
        z = float(orient.get("z", 0.0))
        w = float(orient.get("w", 1.0))
        # roll (x-axis)
        sinr_cosp = 2.0 * (w * x + y * z)
        cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
        roll = math.atan2(sinr_cosp, cosr_cosp)
        sinp = max(-1.0, min(1.0, 2.0 * (w * y - z * x)))
        pitch = math.asin(sinp)
        with self._lock:
            self._state.imu_roll = roll
            self._state.imu_pitch = pitch

    def _on_camera(self, msg: JsonDict) -> None:
        # rosbridge ships CompressedImage.data as base64-encoded JPEG bytes.
        data = msg.get("data")
        if not isinstance(data, str):
            return
        try:
            jpeg = base64.b64decode(data)
        except Exception:
            return
        with self._lock:
            self._state.last_camera_jpeg = jpeg

    # ------------------------------------------------------------------
    # Command dispatch
    # ------------------------------------------------------------------
    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        if self._ros is None or not self._ros.is_connected:
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self.backend_name,
                message="rosbridge not connected",
                data={},
            )
        try:
            self._dispatch(cmd)
            with self._lock:
                snap = {
                    "is_walking": self._state.is_walking,
                    "battery_mv": self._state.battery_mv,
                }
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=True,
                backend=self.backend_name,
                message="ok",
                data=snap,
            )
        except Exception as exc:
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self.backend_name,
                message=str(exc),
                data={},
            )

    def _dispatch(self, cmd: CommandEnvelope) -> None:
        import roslibpy

        if cmd.command == "walk.set":
            speed = int(cmd.payload.get("speed", 2))
            height = float(cmd.payload.get("height", 0.036))
            x = float(cmd.payload.get("x", 0.0))
            y = float(cmd.payload.get("y", 0.0))
            yaw = float(cmd.payload.get("yaw", 0.0))
            with self._lock:
                self._state.walk_speed = speed
                self._state.walk_height = height
                self._state.walk_x = x
                self._state.walk_y = y
                self._state.walk_yaw = yaw
            self._walk_param.publish(
                roslibpy.Message(
                    {"speed": speed, "height": height, "x": x, "y": y, "angle": yaw}
                )
            )
            return

        if cmd.command == "walk.command":
            action = cmd.payload.get("action")
            if not isinstance(action, str):
                raise ValueError("walk.command payload.action must be a string")
            request = roslibpy.ServiceRequest({"command": action})
            self._walking_cmd_srv.call(request, callback=None, errback=None, timeout=2.0)
            return

        if cmd.command == "action.play":
            name = cmd.payload.get("name")
            if not isinstance(name, str) or name == "":
                raise ValueError("action.play payload.name must be non-empty")
            self._action_pub.publish(roslibpy.Message({"data": name}))
            return

        if cmd.command == "head.set":
            pan = float(cmd.payload.get("pan", 0.0))
            tilt = float(cmd.payload.get("tilt", 0.0))
            duration = float(cmd.payload.get("duration", 0.3))
            with self._lock:
                self._state.head_pan = pan
                self._state.head_tilt = tilt
            self._head_pan_pub.publish(
                roslibpy.Message({"position": pan, "duration": duration})
            )
            self._head_tilt_pub.publish(
                roslibpy.Message({"position": tilt, "duration": duration})
            )
            return

        if cmd.command == "servo.set":
            duration = float(cmd.payload.get("duration", 0.3))
            positions_value = cmd.payload.get("positions")
            if not isinstance(positions_value, list):
                raise ValueError("servo.set payload.positions must be a list")
            positions: list[JsonDict] = []
            for item in positions_value:
                if not isinstance(item, dict):
                    continue
                positions.append(
                    {"id": int(item.get("id", 0)), "position": int(item.get("position", 500))}
                )
            self._servo_pub.publish(
                roslibpy.Message({"duration": duration, "position": positions})
            )
            return

        raise ValueError(f"unsupported command: {cmd.command}")

    async def poll_events(self) -> list[EventEnvelope]:
        with self._lock:
            telemetry = EventEnvelope(
                event="telemetry.basic",
                timestamp=utc_now_iso(),
                backend=self.backend_name,
                data={
                    "battery_mv": self._state.battery_mv,
                    "is_walking": self._state.is_walking,
                    "imu_roll": self._state.imu_roll,
                    "imu_pitch": self._state.imu_pitch,
                    "walk_x": self._state.walk_x,
                    "walk_y": self._state.walk_y,
                    "walk_yaw": self._state.walk_yaw,
                    "walk_speed": self._state.walk_speed,
                    "walk_height": self._state.walk_height,
                    "head_pan": self._state.head_pan,
                    "head_tilt": self._state.head_tilt,
                    "joint_positions": dict(self._state.joint_positions),
                },
            )
        return [telemetry]

    async def read_joint_positions(self, servo_ids: list[int] | None = None) -> dict[str, float]:
        """Synchronously call /ros_robot_controller/bus_servo/get_position and
        return {joint_name: radians}. Used by sys-ID and trajectory loggers.
        """
        if self._ros is None or not self._ros.is_connected:
            return {}
        import roslibpy

        from eliza_robot.bridge.isaaclab.joint_map import (
            pulse_to_radians,
            servo_id_to_joint_name,
        )

        ids = servo_ids or list(range(1, 25))
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()

        def _on_response(resp):
            try:
                positions = {}
                for item in resp.get("position", []):
                    sid = int(item["id"])
                    pulse = int(item["position"])
                    name = servo_id_to_joint_name(sid)
                    positions[name] = pulse_to_radians(pulse, sid)
                loop.call_soon_threadsafe(fut.set_result, positions)
            except Exception as exc:
                loop.call_soon_threadsafe(fut.set_exception, exc)

        def _on_error(err):
            loop.call_soon_threadsafe(
                fut.set_exception, RuntimeError(f"get_position failed: {err}")
            )

        self._servo_pos_srv.call(
            roslibpy.ServiceRequest({"id": ids}),
            callback=_on_response, errback=_on_error, timeout=3.0,
        )
        try:
            return await asyncio.wait_for(fut, timeout=4.0)
        except (asyncio.TimeoutError, Exception):
            return {}

    def snapshot_camera(self, _camera: str = "head") -> np.ndarray | None:
        """Decode the most recent /camera/image_raw/compressed frame to RGB."""
        with self._lock:
            jpeg = self._state.last_camera_jpeg
        if jpeg is None:
            return None
        try:
            import cv2

            arr = np.frombuffer(jpeg, dtype=np.uint8)
            bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if bgr is None:
                return None
            return bgr[:, :, ::-1].copy()
        except Exception:
            return None
