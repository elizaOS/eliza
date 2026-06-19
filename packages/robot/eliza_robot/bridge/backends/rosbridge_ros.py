"""ROS1-backed adapter that exposes ROSBridge-like operations."""

from __future__ import annotations

from dataclasses import dataclass

from eliza_robot.bridge.async_compat import run_in_thread
from eliza_robot.bridge.backends.rosbridge_base import RosbridgeBackend
from eliza_robot.bridge.types import JsonDict


@dataclass
class _RosTopicCache:
    is_walking: bool = False
    battery_mv: int = 0
    imu_orientation: JsonDict | None = None


class Ros1RosbridgeBackend(RosbridgeBackend):
    """Maps ROSBridge operations to real/sim ROS1 topics and services."""

    def __init__(self, backend_name: str) -> None:
        if backend_name not in {"ros_real", "ros_sim"}:
            raise ValueError("backend_name must be ros_real or ros_sim")
        self._backend_name = backend_name
        self._cache = _RosTopicCache()
        self._ready = False

        self._walk_param_pub: object | None = None
        self._action_pub: object | None = None
        self._head_pan_pub: object | None = None
        self._head_tilt_pub: object | None = None
        self._servo_set_position_pub: object | None = None
        self._servo_set_state_pub: object | None = None
        self._walking_command_srv: object | None = None
        self._bus_servo_get_position_srv: object | None = None
        self._bus_servo_get_state_srv: object | None = None

    @property
    def backend_name(self) -> str:
        return self._backend_name

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
        }

    async def connect(self) -> None:
        # rospy.init_node registers process signals and must run in main thread.
        self._connect_blocking()

    def _connect_blocking(self) -> None:
        import rospy
        from ainex_interfaces.msg import AppWalkingParam, HeadState
        from ainex_interfaces.srv import SetWalkingCommand
        from ros_robot_controller.msg import SetBusServoState, SetBusServosPosition
        from ros_robot_controller.srv import GetBusServoState, GetBusServosPosition
        from sensor_msgs.msg import Imu
        from std_msgs.msg import Bool, String, UInt16

        if not rospy.core.is_initialized():
            rospy.init_node(f"ainex_rosbridge_{self.backend_name}", anonymous=True)

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
        self._servo_set_position_pub = rospy.Publisher(
            "/ros_robot_controller/bus_servo/set_position", SetBusServosPosition, queue_size=1
        )
        self._servo_set_state_pub = rospy.Publisher(
            "/ros_robot_controller/bus_servo/set_state", SetBusServoState, queue_size=1
        )
        self._walking_command_srv = rospy.ServiceProxy(
            "/walking/command", SetWalkingCommand
        )
        self._bus_servo_get_position_srv = rospy.ServiceProxy(
            "/ros_robot_controller/bus_servo/get_position", GetBusServosPosition
        )
        self._bus_servo_get_state_srv = rospy.ServiceProxy(
            "/ros_robot_controller/bus_servo/get_state", GetBusServoState
        )

        rospy.Subscriber("/walking/is_walking", Bool, self._walking_callback, queue_size=1)
        rospy.Subscriber(
            "/ros_robot_controller/battery", UInt16, self._battery_callback, queue_size=1
        )
        rospy.Subscriber("/imu", Imu, self._imu_callback, queue_size=1)
        self._ready = True

    def _walking_callback(self, msg: object) -> None:
        self._cache.is_walking = bool(getattr(msg, "data", False))

    def _battery_callback(self, msg: object) -> None:
        self._cache.battery_mv = int(getattr(msg, "data", 0))

    def _imu_callback(self, msg: object) -> None:
        orientation = getattr(msg, "orientation", None)
        if orientation is None:
            return
        w_value = float(getattr(orientation, "w", 1.0))
        x_value = float(getattr(orientation, "x", 0.0))
        y_value = float(getattr(orientation, "y", 0.0))
        z_value = float(getattr(orientation, "z", 0.0))
        self._cache.imu_orientation = {
            "x": x_value,
            "y": y_value,
            "z": z_value,
            "w": w_value,
        }

    async def shutdown(self) -> None:
        self._ready = False

    async def publish(self, topic: str, message: JsonDict) -> None:
        if not self._ready:
            raise RuntimeError("backend not connected")
        _ = await run_in_thread(self._publish_blocking, topic, message)

    def _publish_blocking(self, topic: str, message: JsonDict) -> None:
        from ainex_interfaces.msg import AppWalkingParam, HeadState
        from ros_robot_controller.msg import (
            BusServoPosition,
            BusServoState,
            SetBusServoState,
            SetBusServosPosition,
        )
        from std_msgs.msg import String

        if topic == "/app/set_walking_param":
            msg = AppWalkingParam()
            msg.speed = int(message.get("speed", 2))
            msg.height = float(message.get("height", 0.036))
            msg.x = float(message.get("x", 0.0))
            msg.y = float(message.get("y", 0.0))
            msg.angle = float(message.get("angle", 0.0))
            if self._walk_param_pub is None:
                raise RuntimeError("walk param publisher not ready")
            self._walk_param_pub.publish(msg)
            return

        if topic == "/app/set_action":
            action_name = message.get("data")
            if not isinstance(action_name, str) or action_name == "":
                raise ValueError("action payload must include non-empty 'data' string")
            if self._action_pub is None:
                raise RuntimeError("action publisher not ready")
            self._action_pub.publish(String(data=action_name))
            return

        if topic in {"/head_pan_controller/command", "/head_tilt_controller/command"}:
            position = float(message.get("position", 0.0))
            duration = float(message.get("duration", 0.3))
            state = HeadState(position=position, duration=duration)
            if topic == "/head_pan_controller/command":
                if self._head_pan_pub is None:
                    raise RuntimeError("head pan publisher not ready")
                self._head_pan_pub.publish(state)
                return
            if self._head_tilt_pub is None:
                raise RuntimeError("head tilt publisher not ready")
            self._head_tilt_pub.publish(state)
            return

        if topic == "/ros_robot_controller/bus_servo/set_position":
            duration_value = float(message.get("duration", 0.3))
            positions_value = message.get("position")
            if not isinstance(positions_value, list):
                raise ValueError("servo position payload.position must be a list")
            position_msgs: list[BusServoPosition] = []
            for item in positions_value:
                if not isinstance(item, dict):
                    raise ValueError("servo position item must be an object")
                servo_id = int(item.get("id", 0))
                servo_pos = int(item.get("position", 0))
                position_msgs.append(BusServoPosition(id=servo_id, position=servo_pos))
            if self._servo_set_position_pub is None:
                raise RuntimeError("servo set_position publisher not ready")
            self._servo_set_position_pub.publish(
                SetBusServosPosition(duration=duration_value, position=position_msgs)
            )
            return

        if topic == "/ros_robot_controller/bus_servo/set_state":
            duration_value = float(message.get("duration", 0.3))
            state_value = message.get("state")
            if not isinstance(state_value, list):
                raise ValueError("servo state payload.state must be a list")

            state_msgs: list[BusServoState] = []
            for item in state_value:
                if not isinstance(item, dict):
                    raise ValueError("servo state item must be an object")
                servo_state = BusServoState()
                present_id_value = item.get("present_id")
                if isinstance(present_id_value, list):
                    servo_state.present_id = [int(v) for v in present_id_value]
                target_id_value = item.get("target_id")
                if isinstance(target_id_value, list):
                    servo_state.target_id = [int(v) for v in target_id_value]
                position_value = item.get("position")
                if isinstance(position_value, list):
                    servo_state.position = [int(v) for v in position_value]
                offset_value = item.get("offset")
                if isinstance(offset_value, list):
                    servo_state.offset = [int(v) for v in offset_value]
                voltage_value = item.get("voltage")
                if isinstance(voltage_value, list):
                    servo_state.voltage = [int(v) for v in voltage_value]
                temperature_value = item.get("temperature")
                if isinstance(temperature_value, list):
                    servo_state.temperature = [int(v) for v in temperature_value]
                position_limit_value = item.get("position_limit")
                if isinstance(position_limit_value, list):
                    servo_state.position_limit = [int(v) for v in position_limit_value]
                voltage_limit_value = item.get("voltage_limit")
                if isinstance(voltage_limit_value, list):
                    servo_state.voltage_limit = [int(v) for v in voltage_limit_value]
                max_temp_value = item.get("max_temperature_limit")
                if isinstance(max_temp_value, list):
                    servo_state.max_temperature_limit = [int(v) for v in max_temp_value]
                torque_value = item.get("enable_torque")
                if isinstance(torque_value, list):
                    servo_state.enable_torque = [int(v) for v in torque_value]
                save_offset_value = item.get("save_offset")
                if isinstance(save_offset_value, list):
                    servo_state.save_offset = [int(v) for v in save_offset_value]
                stop_value = item.get("stop")
                if isinstance(stop_value, list):
                    servo_state.stop = [int(v) for v in stop_value]
                state_msgs.append(servo_state)

            if self._servo_set_state_pub is None:
                raise RuntimeError("servo set_state publisher not ready")
            self._servo_set_state_pub.publish(
                SetBusServoState(state=state_msgs, duration=duration_value)
            )
            return

        raise ValueError(f"unsupported publish topic: {topic}")

    async def call_service(self, service: str, args: JsonDict) -> JsonDict:
        if not self._ready:
            raise RuntimeError("backend not connected")
        response = await run_in_thread(self._call_service_blocking, service, args)
        if not isinstance(response, dict):
            raise RuntimeError("service response must be a dict")
        return response

    def _call_service_blocking(self, service: str, args: JsonDict) -> JsonDict:
        if service == "/walking/command":
            action = args.get("command")
            if not isinstance(action, str) or action == "":
                raise ValueError("service args must include non-empty 'command' string")
            if self._walking_command_srv is None:
                raise RuntimeError("walking command service not ready")
            result = self._walking_command_srv(action)
            return {"result": bool(getattr(result, "result", False))}

        if service == "/ros_robot_controller/bus_servo/get_position":
            ids_value = args.get("id")
            if not isinstance(ids_value, list):
                raise ValueError("service args.id must be a list")
            ids_list = [int(item) for item in ids_value]
            if self._bus_servo_get_position_srv is None:
                raise RuntimeError("bus_servo get_position service not ready")
            response = self._bus_servo_get_position_srv(ids_list)
            response_positions = getattr(response, "position", [])
            positions: list[JsonDict] = []
            for item in response_positions:
                item_id = int(getattr(item, "id", 0))
                item_position = int(getattr(item, "position", 0))
                positions.append({"id": item_id, "position": item_position})
            return {
                "success": bool(getattr(response, "success", False)),
                "position": positions,
            }

        if service == "/ros_robot_controller/bus_servo/get_state":
            cmd_value = args.get("cmd")
            if not isinstance(cmd_value, list):
                raise ValueError("service args.cmd must be a list")
            if self._bus_servo_get_state_srv is None:
                raise RuntimeError("bus_servo get_state service not ready")

            from ros_robot_controller.msg import GetBusServoCmd

            cmd_msgs: list[GetBusServoCmd] = []
            for item in cmd_value:
                if not isinstance(item, dict):
                    raise ValueError("service cmd item must be an object")
                cmd_msgs.append(
                    GetBusServoCmd(
                        id=int(item.get("id", 0)),
                        get_id=int(item.get("get_id", 0)),
                        get_position=int(item.get("get_position", 0)),
                        get_offset=int(item.get("get_offset", 0)),
                        get_voltage=int(item.get("get_voltage", 0)),
                        get_temperature=int(item.get("get_temperature", 0)),
                        get_position_limit=int(item.get("get_position_limit", 0)),
                        get_voltage_limit=int(item.get("get_voltage_limit", 0)),
                        get_max_temperature_limit=int(item.get("get_max_temperature_limit", 0)),
                        get_torque_state=int(item.get("get_torque_state", 0)),
                    )
                )

            response = self._bus_servo_get_state_srv(cmd_msgs)
            response_states = getattr(response, "state", [])
            states: list[JsonDict] = []
            for item in response_states:
                states.append(
                    {
                        "present_id": [int(v) for v in getattr(item, "present_id", [])],
                        "target_id": [int(v) for v in getattr(item, "target_id", [])],
                        "position": [int(v) for v in getattr(item, "position", [])],
                        "offset": [int(v) for v in getattr(item, "offset", [])],
                        "voltage": [int(v) for v in getattr(item, "voltage", [])],
                        "temperature": [int(v) for v in getattr(item, "temperature", [])],
                        "position_limit": [int(v) for v in getattr(item, "position_limit", [])],
                        "voltage_limit": [int(v) for v in getattr(item, "voltage_limit", [])],
                        "max_temperature_limit": [int(v) for v in getattr(item, "max_temperature_limit", [])],
                        "enable_torque": [int(v) for v in getattr(item, "enable_torque", [])],
                        "save_offset": [int(v) for v in getattr(item, "save_offset", [])],
                        "stop": [int(v) for v in getattr(item, "stop", [])],
                    }
                )
            return {"success": bool(getattr(response, "success", False)), "state": states}

        raise ValueError(f"unsupported service: {service}")

    async def snapshot_topics(self) -> dict[str, JsonDict]:
        imu_message: JsonDict
        if self._cache.imu_orientation is None:
            imu_message = {
                "orientation": {
                    "x": 0.0,
                    "y": 0.0,
                    "z": 0.0,
                    "w": 1.0,
                }
            }
        else:
            imu_message = {"orientation": self._cache.imu_orientation}
        return {
            "/walking/is_walking": {"data": self._cache.is_walking},
            "/ros_robot_controller/battery": {"data": self._cache.battery_mv},
            "/imu": imu_message,
        }
