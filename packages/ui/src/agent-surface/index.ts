/**
 * agent-surface — the unified layer that makes every view fully controllable by
 * the agent: addressable elements, focus awareness, programmatic fill/click,
 * visual indicators, and a capability bridge to the floating-pill chat/voice.
 */

export { AgentElementOverlay } from "./AgentElementOverlay";
export {
  AgentSurfaceContext,
  AgentSurfaceProvider,
  type AgentSurfaceProviderProps,
  useAgentSurface,
} from "./AgentSurfaceContext";
export {
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
} from "./capabilities";
export {
  AgentSurfaceElementReporter,
  useAgentSurfaceElementReporter,
} from "./element-reporter";
export {
  AgentButton,
  type AgentButtonProps,
  AgentInput,
  type AgentInputProps,
  IconTag,
  type IconTagProps,
} from "./components";
export {
  getOrCreateViewRegistry,
  getViewRegistry,
  removeViewRegistry,
  setNativeFieldValue,
  ViewAgentRegistry,
} from "./registry";
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
