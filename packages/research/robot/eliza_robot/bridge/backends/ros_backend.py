"""ROS1 backend adapter mapping websocket commands to AiNex ROS interfaces."""

from __future__ import annotations

from dataclasses import dataclass

from eliza_robot.bridge.async_compat import run_in_thread
from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope, utc_now_iso
from eliza_robot.bridge.types import JsonDict


@dataclass
class _RosState:
    is_walking: bool = False
    battery_mv: int = 0
    imu_roll: float = 0.0
    imu_pitch: float = 0.0
    head_pan: float = 0.0
    head_tilt: float = 0.0
    walk_x: float = 0.0
    walk_y: float = 0.0
    walk_yaw: float = 0.0
    walk_height: float = 0.036
    walk_speed: int = 2
    # Policy mode state
    policy_active: bool = False
    policy_step: int = 0


class RosBridgeBackend(BridgeBackend):
    """
    Real/sim ROS backend.

    This backend is intentionally strict about using the existing AiNex interfaces:
    - /app/set_walking_param (ainex_interfaces/AppWalkingParam)
    - /walking/command (ainex_interfaces/SetWalkingCommand)
    - /app/set_action (std_msgs/String)
    - /head_pan_controller/command, /head_tilt_controller/command (ainex_interfaces/HeadState)
    """

    def __init__(self, backend_name: str) -> None:
        if backend_name not in {"ros_real", "ros_sim"}:
            raise ValueError("backend_name must be ros_real or ros_sim")
        self._backend_name = backend_name
        self._state = _RosState()
        self._ready = False

        self._rospy: object | None = None
        self._walk_param_pub: object | None = None
        self._action_pub: object | None = None
        self._head_pan_pub: object | None = None
        self._head_tilt_pub: object | None = None
        self._walking_command_srv: object | None = None
        self._servo_set_position_pub: object | None = None

    @property
    def backend_name(self) -> str:
        return self._backend_name

    def capabilities(self) -> JsonDict:
        return {
            "walk_set": True,
            "walk_command": True,
            "action_play": True,
            "head_set": True,
            "servo_set": True,
            "camera_stream_passthrough": True,
        }

    async def connect(self) -> None:
        # rospy.init_node registers process signals and must run in main thread.
        self._connect_blocking()

    def _connect_blocking(self) -> None:
        import rospy
        from ainex_interfaces.msg import AppWalkingParam, HeadState
        from ainex_interfaces.srv import SetWalkingCommand
        from std_msgs.msg import Bool, String, UInt16

        self._rospy = rospy
        if not rospy.core.is_initialized():
            rospy.init_node(f"ainex_bridge_{self.backend_name}", anonymous=True)

        self._walk_param_pub = rospy.Publisher(
            "/app/set_walking_param", AppWalkingParam, queue_size=1
        )
        self._action_pub = rospy.Publisher("/app/set_action", String, queue_size=1)
        self._head_pan_pub = rospy.Publisher(
            "/head_pan_controller/command", HeadState, queue_size=1
        )
        self._head_tilt_pub = rospy.Publisher(
            "/head_tilt_controller/command", HeadState, queue_size=1
        )
        self._walking_command_srv = rospy.ServiceProxy(
            "/walking/command", SetWalkingCommand
        )

        from ros_robot_controller.msg import SetBusServosPosition
        self._servo_set_position_pub = rospy.Publisher(
            "/ros_robot_controller/bus_servo/set_position", SetBusServosPosition, queue_size=1
        )

        rospy.Subscriber("/walking/is_walking", Bool, self._walking_callback, queue_size=1)
        rospy.Subscriber(
            "/ros_robot_controller/battery", UInt16, self._battery_callback, queue_size=1
        )
        self._ready = True

    def _walking_callback(self, msg: object) -> None:
        value = getattr(msg, "data", False)
        self._state.is_walking = bool(value)

    def _battery_callback(self, msg: object) -> None:
        value = getattr(msg, "data", 0)
        self._state.battery_mv = int(value)

    def _imu_callback(self, msg: object) -> None:
        orientation = getattr(msg, "orientation", None)
        if orientation is not None:
            # Convert quaternion to roll/pitch (simplified)
            import math
            x = getattr(orientation, "x", 0.0)
            y = getattr(orientation, "y", 0.0)
            z = getattr(orientation, "z", 0.0)
            w = getattr(orientation, "w", 1.0)
            # Roll (x-axis)
            sinr_cosp = 2.0 * (w * x + y * z)
            cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
            self._state.imu_roll = math.atan2(sinr_cosp, cosr_cosp)
            # Pitch (y-axis)
            sinp = 2.0 * (w * y - z * x)
            self._state.imu_pitch = math.asin(max(-1.0, min(1.0, sinp)))

    async def shutdown(self) -> None:
        self._ready = False

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        if not self._ready:
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self.backend_name,
                message="backend not connected",
                data={},
            )

        try:
            _ = await run_in_thread(self._dispatch_blocking, cmd)
            return ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=True,
                backend=self.backend_name,
                message="ok",
                data={
                    "is_walking": self._state.is_walking,
                    "battery_mv": self._state.battery_mv,
                },
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

    def _dispatch_blocking(self, cmd: CommandEnvelope) -> None:
        from ainex_interfaces.msg import AppWalkingParam, HeadState
        from std_msgs.msg import String

        if cmd.command == "walk.set":
            msg = AppWalkingParam()
            msg.speed = int(cmd.payload.get("speed", 2))
            msg.height = float(cmd.payload.get("height", 0.036))
            msg.x = float(cmd.payload.get("x", 0.0))
            msg.y = float(cmd.payload.get("y", 0.0))
            msg.angle = float(cmd.payload.get("yaw", 0.0))
            # Track state for telemetry/policy feedback
            self._state.walk_speed = msg.speed
            self._state.walk_height = msg.height
            self._state.walk_x = msg.x
            self._state.walk_y = msg.y
            self._state.walk_yaw = msg.angle
            if self._walk_param_pub is None:
                raise RuntimeError("walk param publisher not ready")
            self._walk_param_pub.publish(msg)
            return

        if cmd.command == "walk.command":
            action_value = cmd.payload.get("action")
            if not isinstance(action_value, str):
                raise ValueError("walk.command payload.action must be a string")
            if self._walking_command_srv is None:
                raise RuntimeError("walking command service not ready")
            self._walking_command_srv(action_value)
            return

        if cmd.command == "action.play":
            action_name = cmd.payload.get("name")
            if not isinstance(action_name, str) or action_name == "":
                raise ValueError("action.play payload.name must be a non-empty string")
            if self._action_pub is None:
                raise RuntimeError("action publisher not ready")
            self._action_pub.publish(String(data=action_name))
            return

        if cmd.command == "head.set":
            pan = float(cmd.payload.get("pan", 0.0))
            tilt = float(cmd.payload.get("tilt", 0.0))
            duration = float(cmd.payload.get("duration", 0.3))

            # Track state for telemetry/policy feedback
            self._state.head_pan = pan
            self._state.head_tilt = tilt

            pan_msg = HeadState(position=pan, duration=duration)
            tilt_msg = HeadState(position=tilt, duration=duration)

            if self._head_pan_pub is None or self._head_tilt_pub is None:
                raise RuntimeError("head publishers not ready")
            self._head_pan_pub.publish(pan_msg)
            self._head_tilt_pub.publish(tilt_msg)
            return

        if cmd.command == "servo.set":
            from ros_robot_controller.msg import BusServoPosition, SetBusServosPosition

            duration_ms = float(cmd.payload.get("duration", 0.3))
            positions_value = cmd.payload.get("positions")
            if not isinstance(positions_value, list):
                raise ValueError("servo.set payload.positions must be a list")
            position_msgs: list[BusServoPosition] = []
            for item in positions_value:
                if not isinstance(item, dict):
                    raise ValueError("servo.set position item must be an object")
                servo_id = int(item.get("id", 0))
                servo_pos = int(item.get("position", 500))
                position_msgs.append(BusServoPosition(id=servo_id, position=servo_pos))
            if self._servo_set_position_pub is None:
                raise RuntimeError("servo set_position publisher not ready")
            self._servo_set_position_pub.publish(
                SetBusServosPosition(duration=duration_ms, position=position_msgs)
            )
            return

        raise ValueError(f"unsupported command: {cmd.command}")

    async def poll_events(self) -> list[EventEnvelope]:
        if not self._ready:
            return []
        return [
            EventEnvelope(
                event="telemetry.basic",
                timestamp=utc_now_iso(),
                backend=self.backend_name,
                data={
                    "is_walking": self._state.is_walking,
                    "battery_mv": self._state.battery_mv,
                    "imu_roll": self._state.imu_roll,
                    "imu_pitch": self._state.imu_pitch,
                    "walk_x": self._state.walk_x,
                    "walk_y": self._state.walk_y,
                    "walk_yaw": self._state.walk_yaw,
                    "walk_height": self._state.walk_height,
                    "walk_speed": self._state.walk_speed,
                    "head_pan": self._state.head_pan,
                    "head_tilt": self._state.head_tilt,
                },
            )
        ]

