# Hiwonder AiNex — robot assets

Source-of-truth assets for the Hiwonder AiNex humanoid (URDF + meshes + MJCF). Used by `packages/robot/` simulation/training and by `plugins/plugin-ainex/` runtime.

## Layout

```
hiwonder-ainex/
  urdf/          xacro source for the URDF (5 files)
  meshes/        25 binary STL link meshes (~5.5 MB)
  mjcf/          5 MuJoCo XML scenes (ainex, ainex_mjx, ainex_primitives*, ainex_grasp_scene)
  LICENSE_NOTICE.md
  README.md
```

## Source

Ported from `/media/shaw/Extreme SSD/hyperscape-robot-workspace/ainex-robot-code/`:

| Target subdir | SSD source |
|---|---|
| `urdf/` | `ros_ws_src/ainex_simulations/ainex_description/urdf/*.xacro` |
| `meshes/` | `ros_ws_src/ainex_simulations/ainex_description/meshes/*.STL` |
| `mjcf/` | `training/mujoco/{ainex,ainex_mjx,ainex_primitives,ainex_primitives_realistic,ainex_grasp_scene}.xml` |

## Modifications from upstream

1. **URDF**: rewrote 50 `package://ainex_description/meshes/<name>.STL` references in `urdf/ainex.urdf.xacro` to `../meshes/<name>.STL` so the assets resolve outside of a ROS catkin workspace.
2. **URDF**: rewrote 4 `$(find ainex_description)/urdf/<file>.xacro` xacro includes in `urdf/ainex.xacro` and `urdf/ainex.urdf.xacro` to bare relative includes (`<file>.xacro`). xacro's include resolver handles the include relative to the including file.
3. **MJCF**: rewrote `meshdir="../../ros_ws_src/ainex_simulations/ainex_description/meshes/"` in `mjcf/ainex.xml` and `mjcf/ainex_mjx.xml` to `meshdir="../meshes/"`. The `*_primitives*.xml` and `*_grasp_scene.xml` MJCFs are pure shape primitives and do not reference STL meshes.

The xacro files (`*.xacro`) are kept as source; the flattened `*.urdf` is **not** committed because it is an auto-generated build artifact. To regenerate the flattened URDF:

```bash
xacro urdf/ainex.urdf.xacro -o /tmp/ainex.urdf
```

## Build step (xacro → URDF)

Outside of ROS, install `xacro` from PyPI:

```bash
pip install xacro
xacro packages/robot/assets/profiles/hiwonder-ainex/urdf/ainex.urdf.xacro \
  -o packages/robot/assets/profiles/hiwonder-ainex/urdf/ainex.urdf
```

If the catkin-only `gazebo.xacro` block fails (it references the `libgazebo_ros_control` plugin), use `ainex.urdf.xacro` directly instead of the wrapper `ainex.xacro` — `gazebo.xacro` is only needed for Gazebo simulation, not for kinematics/MuJoCo work.

## Calibration files NOT included

Per-robot calibration data (`ros_ws_src/ainex_calibration/config/imu_calib.yaml`, `mag_calib.yaml`, and anything under `calibration_data/`) is intentionally excluded. Those files contain device-specific fitted matrices and are gitignored at the package level. Each physical robot must be calibrated locally.

## License

See `LICENSE_NOTICE.md`. Upstream `package.xml` declares `BSD`.
