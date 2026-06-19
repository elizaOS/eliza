import { describe, expect, it } from "vitest";
import {
  loadProfileFromBridge,
  parseRobotProfileDescriptor,
  robotProfileDescriptorSchema,
} from "../src/profile-schema";
import { AinexBridgeClient } from "../src/bridge-client";
import type { RobotProfileDescriptor } from "../src/types";

const FIXTURE: RobotProfileDescriptor = {
  id: "hiwonder-ainex",
  name: "Hiwonder AiNex",
  version: "1.0.0",
  description: "Test fixture",
  kinematics: {
    dof: 2,
    joints: [
      {
        name: "head_pan",
        index: 0,
        lower_rad: -1.5,
        upper_rad: 1.5,
        home_rad: 0,
        group: "HEAD",
        actuator_torque_nm: 6,
        velocity_max_rad_s: 100,
      },
      {
        name: "head_tilt",
        index: 1,
        lower_rad: -1,
        upper_rad: 1,
        home_rad: 0,
        group: "HEAD",
        actuator_torque_nm: 6,
        velocity_max_rad_s: 100,
      },
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
        frames: [{ t: 0, joints: { head_pan: 0 } }],
      },
    },
  },
  safety: {
    fall_pitch_rad: 0.5,
    fall_roll_rad: 0.5,
    battery_low_mv: 6600,
    deadman_timeout_s: 1.0,
  },
  bridge_capabilities: ["head.set", "action.play"],
};

describe("RobotProfileDescriptor zod schema", () => {
  it("parses a valid fixture", () => {
    const parsed = parseRobotProfileDescriptor(FIXTURE);
    expect(parsed.id).toBe("hiwonder-ainex");
    expect(parsed.kinematics.joints).toHaveLength(2);
  });

  it("rejects a profile whose joints length does not match dof", () => {
    const bad = {
      ...FIXTURE,
      kinematics: { ...FIXTURE.kinematics, dof: 3 },
    };
    expect(() => parseRobotProfileDescriptor(bad)).toThrow();
  });

  it("rejects unknown gait controllers", () => {
    const bad = {
      ...FIXTURE,
      gait: { ...FIXTURE.gait, controller: "nonsense" },
    };
    expect(() => robotProfileDescriptorSchema.parse(bad)).toThrow();
  });

  it("rejects home_rad outside [lower_rad, upper_rad]", () => {
    const bad = {
      ...FIXTURE,
      kinematics: {
        ...FIXTURE.kinematics,
        joints: [
          { ...FIXTURE.kinematics.joints[0]!, home_rad: 5 },
          FIXTURE.kinematics.joints[1]!,
        ],
      },
    };
    expect(() => parseRobotProfileDescriptor(bad)).toThrow();
  });
});

describe("loadProfileFromBridge fallback", () => {
  it("returns a parseable Hiwonder descriptor", async () => {
    const client = new AinexBridgeClient({ url: "ws://localhost:9100" });
    const descriptor = await loadProfileFromBridge(client);
    expect(descriptor.id).toBe("hiwonder-ainex");
    expect(descriptor.kinematics.dof).toBe(24);
    expect(descriptor.kinematics.joints).toHaveLength(24);
    expect(descriptor.sensors.cameras.length).toBeGreaterThanOrEqual(1);
  });
});
