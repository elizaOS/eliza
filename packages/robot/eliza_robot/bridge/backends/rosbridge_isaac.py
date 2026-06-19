"""Isaac-target backend for ROSBridge-compatible websocket operations.

Maps ROSBridge publish/subscribe/service operations to the IsaacLab simulation
state. Uses SimRobotState for deterministic state management. When Isaac Sim
runtime is available, state is synchronized with the live articulation.
"""

from __future__ import annotations

from eliza_robot.bridge.backends.rosbridge_base import RosbridgeBackend
from eliza_robot.bridge.isaaclab.joint_map import JOINT_BY_SERVO_ID, pulse_to_radians
from eliza_robot.bridge.isaaclab.sim_state import SimRobotState
from eliza_robot.bridge.types import JsonDict


class IsaacRosbridgeBackend(RosbridgeBackend):
    """
    Isaac-compatible ROSBridge backend.

    Keeps ROSBridge message/service surfaces stable for endpoint parity.
    Can run without Isaac runtime for development and tests.
    """

    def __init__(self) -> None:
        self._state = SimRobotState()

    @property
    def backend_name(self) -> str:
        return "isaac"

    async def connect(self) -> None:
        self._state.ready = True

    async def shutdown(self) -> None:
        self._state.ready = False

    def capabilities(self) -> JsonDict:
        return {
            "protocol": "rosbridge_compatible",
            "walk_set": True,
            "walk_command_service": True,
            "action_play": True,
            "head_topics": True,
            "servo_position_topic": True,
            "servo_state_topic": True,
            "servo_get_position_service": True,
            "servo_get_state_service": True,
            "camera_stream_passthrough": True,
            "runtime": "isaaclab_adapter",
        }

    async def publish(self, topic: str, message: JsonDict) -> None:
        if not self._state.ready:
            raise RuntimeError("backend not connected")

        if topic == "/app/set_walking_param":
            self._state.apply_walk_params(
                speed=int(message.get("speed", self._state.walk.speed)),
                height=float(message.get("height", self._state.walk.height)),
                x=float(message.get("x", self._state.walk.x)),
                y=float(message.get("y", self._state.walk.y)),
                angle=float(message.get("angle", self._state.walk.angle)),
            )
            return

        if topic == "/app/set_action":
            action_name = message.get("data")
            if not isinstance(action_name, str) or action_name == "":
                raise ValueError("action payload must include non-empty 'data' string")
            self._state.apply_action(action_name)
            return

        if topic == "/head_pan_controller/command":
            self._state.apply_head(pan=float(message.get("position", 0.0)))
            return

        if topic == "/head_tilt_controller/command":
            self._state.apply_head(tilt=float(message.get("position", 0.0)))
            return

        if topic == "/ros_robot_controller/bus_servo/set_position":
            positions_value = message.get("position")
            if isinstance(positions_value, list):
                for item in positions_value:
                    if isinstance(item, dict):
                        servo_id = int(item.get("id", 0))
                        pulse = int(item.get("position", 500))
                        spec = JOINT_BY_SERVO_ID.get(servo_id)
                        if spec is not None:
                            rad = pulse_to_radians(pulse, servo_id)
                            self._state.joint_positions_rad[spec.urdf_name] = rad
            return

        if topic == "/ros_robot_controller/bus_servo/set_state":
            # State-setting payload accepted for protocol parity.
            return

        raise ValueError(f"unsupported publish topic: {topic}")

    async def call_service(self, service: str, args: JsonDict) -> JsonDict:
        if not self._state.ready:
            raise RuntimeError("backend not connected")

        if service == "/walking/command":
            action = args.get("command")
            if not isinstance(action, str) or action == "":
                raise ValueError("service args must include non-empty 'command' string")
            result = self._state.apply_walk_command(action)
            return {"result": result}

        if service == "/ros_robot_controller/bus_servo/get_position":
            ids_value = args.get("id")
            if not isinstance(ids_value, list):
                raise ValueError("service args.id must be a list")
            positions: list[JsonDict] = []
            for servo_id in ids_value:
                sid = int(servo_id)
                pulse = self._state.get_servo_position(sid)
                positions.append({"id": sid, "position": pulse})
            return {"success": True, "position": positions}

        if service == "/ros_robot_controller/bus_servo/get_state":
            cmd_value = args.get("cmd")
            if not isinstance(cmd_value, list):
                raise ValueError("service args.cmd must be a list")
            states: list[JsonDict] = []
            for item in cmd_value:
                if not isinstance(item, dict):
                    raise ValueError("service cmd item must be an object")
                servo_id = int(item.get("id", 0))
                pulse = self._state.get_servo_position(servo_id)
                states.append(
                    {
                        "present_id": [1, servo_id],
                        "target_id": [],
                        "position": [1, pulse],
                        "offset": [1, 0],
                        "voltage": [1, 12000],
                        "temperature": [1, 35],
                        "position_limit": [1, 0, 1000],
                        "voltage_limit": [1, 4500, 14000],
                        "max_temperature_limit": [1, 85],
                        "enable_torque": [1, 1],
                        "save_offset": [0, 0],
                        "stop": [0, 0],
                    }
                )
            return {"success": True, "state": states}

        raise ValueError(f"unsupported service: {service}")

    async def snapshot_topics(self) -> dict[str, JsonDict]:
        self._state.tick()
        return self._state.snapshot_telemetry()
