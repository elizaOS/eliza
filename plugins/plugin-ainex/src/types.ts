// Keep in sync with packages/robot/eliza_robot/profiles/schema.py
//
// These types mirror the Pydantic v2 RobotProfile schema. Any change to the
// Python schema (new field, renamed field, narrower type) MUST be reflected
// here and in src/profile-schema.ts. Drift between the two is a profile bug.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonDict = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Bridge envelopes — match bridge/protocol.py CommandEnvelope/Response/Event.
// ---------------------------------------------------------------------------

export interface CommandEnvelope {
  type: "command";
  request_id: string;
  timestamp: string;
  command: string;
  payload: JsonDict;
  preempt: boolean;
}

export interface ResponseEnvelope {
  type: "response";
  request_id: string;
  timestamp: string;
  ok: boolean;
  backend: string;
  message: string;
  data: JsonDict;
}

export interface EventEnvelope {
  type: "event";
  event: string;
  timestamp: string;
  backend: string;
  data: JsonDict;
}

// Mirrors VALID_COMMANDS in bridge/protocol.py. Kept as a string union now;
// later waves will split this per command with discriminated payload types.
export type BridgeCommand =
  | "walk.set"
  | "walk.command"
  | "action.play"
  | "head.set"
  | "servo.set"
  | "policy.start"
  | "policy.stop"
  | "policy.tick"
  | "policy.status"
  | "profile.describe"
  | "camera.snapshot";

// Mirrors VALID_EVENTS in bridge/protocol.py.
export type BridgeEvent =
  | "session.hello"
  | "telemetry.basic"
  | "safety.deadman_triggered"
  | "telemetry.perception"
  | "telemetry.policy"
  | "safety.policy_guard"
  | "policy.status";

// ---------------------------------------------------------------------------
// RobotProfile mirror — see packages/robot/eliza_robot/profiles/schema.py
// ---------------------------------------------------------------------------

export type JointGroup = "LEG" | "ARM" | "HEAD";

export type GaitController = "bezier" | "rl" | "openpi";

export interface JointSpec {
  name: string;
  index: number;
  lower_rad: number;
  upper_rad: number;
  home_rad: number;
  group: JointGroup;
  actuator_torque_nm: number;
  velocity_max_rad_s: number;
}

export interface Kinematics {
  dof: number;
  joints: JointSpec[];
}

export interface GaitParams {
  cycle_hz: number;
  swing_height_m: number;
  stance_width_m: number;
  step_length_max_m: number;
  foot_offset_m: number;
  default_height_m: number;
  controller: GaitController;
}

/** (roll, pitch, yaw, x, y, z) relative to mount_link. */
export type ExtrinsicsRpyXyz = [
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface CameraSpec {
  name: string;
  width: number;
  height: number;
  fps: number;
  fov_deg: number;
  mount_link: string;
  extrinsics_rpy_xyz: ExtrinsicsRpyXyz;
}

export interface SensorSpecs {
  imu_noise_std: number;
  cameras: CameraSpec[];
}

export interface ControlSpec {
  rate_hz: number;
  command_smoothing: number;
  max_joint_delta_rad_per_step: number;
  safe_torque_clip_nm: number;
}

export interface AssetPaths {
  mjcf_xml: string;
  mjx_xml: string;
  urdf: string;
  mesh_dir: string;
}

export interface Frame {
  t: number;
  joints: Record<string, number>;
}

export interface ActionGroup {
  name: string;
  duration_s: number;
  frames: Frame[];
}

export interface ActionLibrary {
  groups: Record<string, ActionGroup>;
}

export interface SafetyLimits {
  fall_pitch_rad: number;
  fall_roll_rad: number;
  battery_low_mv: number;
  deadman_timeout_s: number;
}

/**
 * Full robot profile descriptor as fetched from the bridge `profile.describe`
 * command or loaded from a local YAML manifest. Replaces the earlier
 * placeholder; field-for-field mirror of the Python RobotProfile model.
 */
export interface RobotProfileDescriptor {
  id: string;
  name: string;
  version: string;
  description: string;
  kinematics: Kinematics;
  gait: GaitParams;
  sensors: SensorSpecs;
  control: ControlSpec;
  assets: AssetPaths;
  actions: ActionLibrary;
  safety: SafetyLimits;
  bridge_capabilities: BridgeCommand[];
}
