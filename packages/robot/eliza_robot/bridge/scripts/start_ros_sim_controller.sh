#!/usr/bin/env bash
set -euo pipefail

# Start AiNex kinematics controller in gazebo_sim mode.
# Run this in a ROS environment where `roslaunch` and AiNex packages are sourced.

exec roslaunch ainex_kinematics ainex_controller.launch gazebo_sim:=true

