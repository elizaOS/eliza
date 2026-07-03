/**
 * agent-surface — the unified layer that makes every view fully controllable by
 * the agent: addressable elements, focus awareness, programmatic fill/click,
 * visual indicators, and a capability bridge to the floating-pill chat/voice.
 */

export { AgentElementOverlay } from "./AgentElementOverlay";
export {
  AgentSurfaceProvider,
  type AgentSurfaceProviderProps,
} from "./AgentSurfaceContext";
export {
  AgentSurfaceContext,
  useAgentSurface,
} from "./AgentSurfaceContext.hooks";
export {
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
} from "./capabilities";
export {
  AgentButton,
  type AgentButtonProps,
  AgentInput,
  type AgentInputProps,
  IconTag,
  type IconTagProps,
} from "./components";
export { AgentSurfaceElementReporter } from "./element-reporter";
export { useAgentSurfaceElementReporter } from "./element-reporter.hooks";
export {
  getOrCreateViewRegistry,
  getViewRegistry,
  removeViewRegistry,
  setNativeFieldValue,
  ViewAgentRegistry,
} from "./registry";
export {
  isSensitiveAgentElement,
  SENSITIVE_AGENT_ELEMENT_REASON,
} from "./sensitive";
export {
  AGENT_SURFACE_CAPABILITY_IDS,
  type AgentActionResult,
  type AgentElementDescriptor,
  type AgentElementRole,
  type AgentElementSnapshot,
  type AgentSurfaceSnapshot,
  type AgentViewType,
  CLICKABLE_ROLES,
  FILLABLE_ROLES,
} from "./types";
export {
  type AgentElementHandle,
  useAgentElement,
} from "./useAgentElement";
