/**
 * Barrel for the backgrounds surface (@elizaos/ui backgrounds).
 */
export { AppBackground, type AppBackgroundProps } from "./AppBackground";
export {
  applyRootCanvasPaint,
  computeRootCanvasPaint,
  type RootCanvasPaint,
} from "./html-canvas-paint";
export { ImageBackground, type ImageBackgroundProps } from "./ImageBackground";
export {
  ProgrammableShaderBackground,
  type ProgrammableShaderBackgroundProps,
} from "./ProgrammableShaderBackground";
export {
  ShaderBackground,
  type ShaderBackgroundProps,
} from "./ShaderBackground";
export {
  getShaderPreset,
  SHADER_PRESETS,
  type ShaderPreset,
} from "./shader-presets";
export {
  DEFAULT_SHADER_UNIFORMS,
  hexToRgb,
  isPlausibleFragmentSource,
  mergeUniforms,
  normalizeUniforms,
  type ShaderUniformValues,
  UNIFORM_SCHEMA,
  uniformsEqual,
} from "./shader-schema";
export {
  BACKGROUND_APPLY_EVENT,
  type BackgroundApplyOp,
  type BackgroundApplyPayload,
  useBackgroundApplyChannel,
} from "./useBackgroundApplyChannel";
