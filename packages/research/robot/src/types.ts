/**
 * Identifier for a robot profile (e.g. "hiwonder-ainex").
 *
 * Profiles are first-class: every URDF, asset bundle, gait, calibration,
 * and bridge configuration is keyed by `RobotProfileId`. Concrete profile
 * schemas land in W1.4.
 */
export type RobotProfileId = string;
