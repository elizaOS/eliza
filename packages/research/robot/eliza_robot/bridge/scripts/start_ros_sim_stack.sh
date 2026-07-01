#!/usr/bin/env bash
set -euo pipefail

# Start Gazebo world + spawn model + position controllers.
# Run this in a ROS environment where `roslaunch` and AiNex packages are sourced.

exec roslaunch ainex_gazebo worlds.launch

