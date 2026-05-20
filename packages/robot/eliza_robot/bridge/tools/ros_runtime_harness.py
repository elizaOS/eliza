"""Minimal ROS runtime harness for bridge backend integration tests."""

from __future__ import annotations

import threading
import time

import rospy
from ainex_interfaces.srv import SetWalkingCommand, SetWalkingCommandResponse
from ros_robot_controller.msg import BusServoPosition, BusServoState
from ros_robot_controller.srv import (
    GetBusServoState,
    GetBusServoStateResponse,
    GetBusServosPosition,
    GetBusServosPositionResponse,
)
from sensor_msgs.msg import Imu
from std_msgs.msg import Bool, UInt16


class HarnessState:
    def __init__(self) -> None:
        self.is_walking = False
        self.walking_enabled = True
        self.battery_mv = 12300


def _handle_walking_command(
    request: object, state: HarnessState
) -> SetWalkingCommandResponse:
    command_value = getattr(request, "command", "")
    if command_value == "start":
        if state.walking_enabled:
            state.is_walking = True
        return SetWalkingCommandResponse(result=True)
    if command_value == "stop":
        state.is_walking = False
        return SetWalkingCommandResponse(result=True)
    if command_value == "enable":
        state.walking_enabled = True
        return SetWalkingCommandResponse(result=True)
    if command_value == "disable":
        state.walking_enabled = False
        state.is_walking = False
        return SetWalkingCommandResponse(result=True)
    if command_value in {"enable_control", "disable_control"}:
        return SetWalkingCommandResponse(result=True)
    return SetWalkingCommandResponse(result=False)


def _handle_get_bus_servo_position(request: object) -> GetBusServosPositionResponse:
    ids_value = getattr(request, "id", [])
    positions: list[BusServoPosition] = []
    for item in ids_value:
        positions.append(BusServoPosition(id=int(item), position=500))
    return GetBusServosPositionResponse(success=True, position=positions)


def _handle_get_bus_servo_state(request: object) -> GetBusServoStateResponse:
    cmd_value = getattr(request, "cmd", [])
    states: list[BusServoState] = []
    for cmd in cmd_value:
        servo_id = int(getattr(cmd, "id", 0))
        states.append(
            BusServoState(
                present_id=[1, servo_id],
                target_id=[],
                position=[1, 500],
                offset=[1, 0],
                voltage=[1, 12000],
                temperature=[1, 35],
                position_limit=[1, 0, 1000],
                voltage_limit=[1, 4500, 14000],
                max_temperature_limit=[1, 85],
                enable_torque=[1, 1],
                save_offset=[0, 0],
                stop=[0, 0],
            )
        )
    return GetBusServoStateResponse(success=True, state=states)


def _publisher_loop(state: HarnessState) -> None:
    walking_pub = rospy.Publisher("/walking/is_walking", Bool, queue_size=1)
    battery_pub = rospy.Publisher("/ros_robot_controller/battery", UInt16, queue_size=1)
    imu_pub = rospy.Publisher("/imu", Imu, queue_size=1)
    rate = rospy.Rate(20)
    while not rospy.is_shutdown():
        battery_pub.publish(UInt16(data=state.battery_mv))
        walking_pub.publish(Bool(data=state.is_walking))
        imu_msg = Imu()
        imu_msg.orientation.w = 1.0
        imu_pub.publish(imu_msg)
        state.battery_mv = max(10400, state.battery_mv - 1)
        rate.sleep()


def main() -> None:
    rospy.init_node("bridge_ros_runtime_harness", anonymous=True)
    state = HarnessState()

    rospy.Service(
        "/walking/command",
        SetWalkingCommand,
        lambda request: _handle_walking_command(request, state),
    )
    rospy.Service(
        "/ros_robot_controller/bus_servo/get_position",
        GetBusServosPosition,
        _handle_get_bus_servo_position,
    )
    rospy.Service(
        "/ros_robot_controller/bus_servo/get_state",
        GetBusServoState,
        _handle_get_bus_servo_state,
    )

    thread = threading.Thread(target=_publisher_loop, args=(state,), daemon=True)
    thread.start()
    rospy.spin()


if __name__ == "__main__":
    main()
