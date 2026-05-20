/**
 * Client-safe perpetual market exports.
 *
 * Keep this file limited to pure utilities and types that do not import
 * database adapters or other Node-only dependencies.
 */

export {
  getEffectivePerpLeverage,
  getOpenPerpPositionIntegrityIssue,
  getPerpPositionExposure,
  isOpenPerpPositionStateValid,
  MAX_PERP_USER_EXPOSURE,
  shouldLiquidate,
} from "./utils";
