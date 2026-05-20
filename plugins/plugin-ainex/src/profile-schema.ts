// Keep in sync with packages/robot/eliza_robot/profiles/schema.py
//
// Zod schemas for RobotProfileDescriptor and its component types. Mirror of
// the Pydantic RobotProfile schema; parses both bridge `profile.describe`
// responses and locally cached profile JSON dumps.

import { z } from "zod";
import type { AinexBridgeClient } from "./bridge-client";
import type { BridgeCommand, RobotProfileDescriptor } from "./types";

export const jointGroupSchema = z.enum(["LEG", "ARM", "HEAD"]);
export const gaitControllerSchema = z.enum(["bezier", "rl", "openpi"]);

export const bridgeCommandSchema: z.ZodType<BridgeCommand> = z.enum([
  "walk.set",
  "walk.command",
  "action.play",
  "head.set",
  "servo.set",
  "policy.start",
  "policy.stop",
  "policy.tick",
  "policy.status",
  "profile.describe",
]);

export const jointSpecSchema = z
  .object({
    name: z.string().min(1),
    index: z.number().int().nonnegative(),
    lower_rad: z.number(),
    upper_rad: z.number(),
    home_rad: z.number(),
    group: jointGroupSchema,
    actuator_torque_nm: z.number().positive(),
    velocity_max_rad_s: z.number().positive(),
  })
  .refine((j) => j.upper_rad > j.lower_rad, {
    message: "upper_rad must be greater than lower_rad",
  })
  .refine((j) => j.home_rad >= j.lower_rad && j.home_rad <= j.upper_rad, {
    message: "home_rad must lie within [lower_rad, upper_rad]",
  });

export const kinematicsSchema = z
  .object({
    dof: z.number().int().positive(),
    joints: z.array(jointSpecSchema).min(1),
  })
  .refine((k) => k.joints.length === k.dof, {
    message: "joints length must equal dof",
  });

export const gaitParamsSchema = z.object({
  cycle_hz: z.number().positive(),
  swing_height_m: z.number().positive(),
  stance_width_m: z.number().positive(),
  step_length_max_m: z.number().positive(),
  foot_offset_m: z.number(),
  default_height_m: z.number().positive(),
  controller: gaitControllerSchema,
});

export const extrinsicsRpyXyzSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

export const cameraSpecSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  fov_deg: z.number().positive().lt(360),
  mount_link: z.string().min(1),
  extrinsics_rpy_xyz: extrinsicsRpyXyzSchema,
});

export const sensorSpecsSchema = z.object({
  imu_noise_std: z.number().nonnegative(),
  cameras: z.array(cameraSpecSchema),
});

export const controlSpecSchema = z.object({
  rate_hz: z.number().positive(),
  command_smoothing: z.number().min(0).max(1),
  max_joint_delta_rad_per_step: z.number().positive(),
  safe_torque_clip_nm: z.number().positive(),
});

export const assetPathsSchema = z.object({
  mjcf_xml: z.string().min(1),
  mjx_xml: z.string().min(1),
  urdf: z.string().min(1),
  mesh_dir: z.string().min(1),
});

export const frameSchema = z.object({
  t: z.number().nonnegative(),
  joints: z.record(z.string(), z.number()),
});

export const actionGroupSchema = z
  .object({
    name: z.string().min(1),
    duration_s: z.number().positive(),
    frames: z.array(frameSchema).min(1),
  })
  .refine(
    (g) => g.frames[g.frames.length - 1]!.t <= g.duration_s,
    { message: "last frame t must be <= duration_s" },
  );

export const actionLibrarySchema = z.object({
  groups: z.record(z.string(), actionGroupSchema),
});

export const safetyLimitsSchema = z.object({
  fall_pitch_rad: z.number().positive(),
  fall_roll_rad: z.number().positive(),
  battery_low_mv: z.number().int().positive(),
  deadman_timeout_s: z.number().positive(),
});

export const robotProfileDescriptorSchema: z.ZodType<RobotProfileDescriptor> =
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string(),
    kinematics: kinematicsSchema,
    gait: gaitParamsSchema,
    sensors: sensorSpecsSchema,
    control: controlSpecSchema,
    assets: assetPathsSchema,
    actions: actionLibrarySchema,
    safety: safetyLimitsSchema,
    bridge_capabilities: z.array(bridgeCommandSchema),
  });

export function parseRobotProfileDescriptor(
  raw: unknown,
): RobotProfileDescriptor {
  return robotProfileDescriptorSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Bridge fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the active robot profile from the bridge via `profile.describe`.
 *
 * Falls back to the bundled Hiwonder AiNex descriptor when the bridge is
 * unreachable (so offline CI tests and pre-connection plugin init still
 * resolve a valid profile to provider/action callers).
 */
export async function loadProfileFromBridge(
  client: AinexBridgeClient,
): Promise<RobotProfileDescriptor> {
  if (!client.isConnected()) {
    return parseRobotProfileDescriptor(HIWONDER_AINEX_FALLBACK);
  }
  try {
    const response = await client.send("profile.describe", {});
    if (!response.ok) {
      return parseRobotProfileDescriptor(HIWONDER_AINEX_FALLBACK);
    }
    const profile = response.data.profile;
    if (!profile) {
      return parseRobotProfileDescriptor(HIWONDER_AINEX_FALLBACK);
    }
    return parseRobotProfileDescriptor(profile);
  } catch {
    return parseRobotProfileDescriptor(HIWONDER_AINEX_FALLBACK);
  }
}

// Hardcoded Hiwonder AiNex descriptor. Mirrors profile.yaml exactly. When
// the bridge implements `profile.describe`, this becomes redundant — but
// it stays as a safety net for offline/CI tests.
const HIWONDER_AINEX_FALLBACK: RobotProfileDescriptor = {
  id: "hiwonder-ainex",
  name: "Hiwonder AiNex",
  version: "1.0.0",
  description:
    "24-DoF Hiwonder AiNex humanoid (12 legs + 2 head + 10 arms incl. grippers).",
  kinematics: {
    dof: 24,
    joints: [
      // LEGS
      { name: "r_hip_yaw", index: 0, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_hip_roll", index: 1, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_hip_pitch", index: 2, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_knee", index: 3, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_ank_pitch", index: 4, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_ank_roll", index: 5, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_hip_yaw", index: 6, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_hip_roll", index: 7, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_hip_pitch", index: 8, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_knee", index: 9, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_ank_pitch", index: 10, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_ank_roll", index: 11, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "LEG", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      // HEAD
      { name: "head_pan", index: 12, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "HEAD", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "head_tilt", index: 13, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "HEAD", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      // ARMS
      { name: "r_sho_pitch", index: 14, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_sho_roll", index: 15, lower_rad: -2.09, upper_rad: 2.09, home_rad: 1.403, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_el_pitch", index: 16, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_el_yaw", index: 17, lower_rad: -2.09, upper_rad: 2.09, home_rad: 1.226, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "r_gripper", index: 18, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_sho_pitch", index: 19, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_sho_roll", index: 20, lower_rad: -2.09, upper_rad: 2.09, home_rad: -1.403, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_el_pitch", index: 21, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_el_yaw", index: 22, lower_rad: -2.09, upper_rad: 2.09, home_rad: -1.226, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
      { name: "l_gripper", index: 23, lower_rad: -2.09, upper_rad: 2.09, home_rad: 0, group: "ARM", actuator_torque_nm: 6, velocity_max_rad_s: 100 },
    ],
  },
  gait: {
    cycle_hz: 1.25,
    swing_height_m: 0.08,
    stance_width_m: 0.1,
    step_length_max_m: 0.05,
    foot_offset_m: -0.25,
    default_height_m: 0.25,
    controller: "bezier",
  },
  sensors: {
    imu_noise_std: 0.01,
    cameras: [
      {
        name: "head_rgb",
        width: 640,
        height: 480,
        fps: 30,
        fov_deg: 120,
        mount_link: "head_tilt_link",
        extrinsics_rpy_xyz: [0, 0, 0, 0.05, 0, 0.03],
      },
    ],
  },
  control: {
    rate_hz: 50,
    command_smoothing: 0.2,
    max_joint_delta_rad_per_step: 0.3,
    safe_torque_clip_nm: 6,
  },
  assets: {
    mjcf_xml: "ainex.xml",
    mjx_xml: "ainex_mjx.xml",
    urdf: "ainex.urdf",
    mesh_dir: "meshes",
  },
  actions: {
    groups: {
      stand: {
        name: "stand",
        duration_s: 1,
        frames: [{ t: 0, joints: { r_hip_pitch: 0, l_hip_pitch: 0 } }],
      },
      sit: {
        name: "sit",
        duration_s: 1.5,
        frames: [
          { t: 0, joints: { r_hip_pitch: 0, l_hip_pitch: 0 } },
          {
            t: 1.5,
            joints: {
              r_hip_pitch: -0.9,
              l_hip_pitch: -0.9,
              r_knee: 1.6,
              l_knee: 1.6,
            },
          },
        ],
      },
      wave: {
        name: "wave",
        duration_s: 2,
        frames: [
          { t: 0, joints: { r_sho_roll: 1.403, r_el_yaw: 1.226 } },
          { t: 1, joints: { r_sho_pitch: -1.2, r_sho_roll: 0.6 } },
          { t: 2, joints: { r_sho_roll: 1.403, r_el_yaw: 1.226 } },
        ],
      },
      bow: {
        name: "bow",
        duration_s: 2,
        frames: [
          { t: 0, joints: { r_hip_pitch: 0, head_tilt: 0 } },
          { t: 1, joints: { r_hip_pitch: -0.5, head_tilt: 0.5 } },
          { t: 2, joints: { r_hip_pitch: 0, head_tilt: 0 } },
        ],
      },
    },
  },
  safety: {
    fall_pitch_rad: 0.5,
    fall_roll_rad: 0.5,
    battery_low_mv: 6600,
    deadman_timeout_s: 1.0,
  },
  bridge_capabilities: [
    "walk.set",
    "walk.command",
    "head.set",
    "action.play",
    "servo.set",
    "policy.start",
    "policy.stop",
    "policy.tick",
    "policy.status",
  ],
};
