/** Browser-safe renderer observations. These fields grant no device or provider authority. */
import { parseViewInteractionClientId } from "@elizaos/core/view-interaction";

/** Renderer observations only; the runtime registry owns capabilities and authority. */
export interface VoiceUiContext {
  uiViewPath?: string;
  uiViewSubview?: string;
  uiTimeZone?: string;
  uiBrowserSurface?: "native";
  /** Existing renderer claim/ack delivery protocol; not navigation authority. */
  viewDelivery?: "completed-action";
  /** Same renderer routing ID used by its authenticated HTTP/WS client. */
  uiClientId?: string;
  /** Current bound user preference; never grants system or provider permissions. */
  agentActionMode?: "direct-request-v1";
}

/** Small allowlist shared by the wire and loopback boundaries. */
export function parseVoiceUiContext(value: unknown): VoiceUiContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result: VoiceUiContext = {};
  if (source.viewDelivery !== undefined) {
    if (source.viewDelivery !== "completed-action") return null;
    result.viewDelivery = "completed-action";
  }
  if (source.uiClientId !== undefined) {
    const clientId = parseViewInteractionClientId(source.uiClientId);
    if (!clientId) return null;
    result.uiClientId = clientId;
  }
  if (source.agentActionMode !== undefined) {
    if (
      source.agentActionMode !== "direct-request-v1" ||
      result.viewDelivery !== "completed-action" ||
      !result.uiClientId
    )
      return null;
    result.agentActionMode = "direct-request-v1";
  }
  if (source.uiBrowserSurface !== undefined) {
    if (source.uiBrowserSurface !== "native") return null;
    result.uiBrowserSurface = "native";
  }
  for (const key of ["uiViewPath", "uiViewSubview", "uiTimeZone"] as const) {
    const field = source[key];
    if (field === undefined) continue;
    if (
      typeof field !== "string" ||
      field.length > (key === "uiViewPath" ? 2048 : 128)
    )
      return null;
    result[key] = field;
  }
  if (
    result.uiViewPath &&
    (!result.uiViewPath.startsWith("/") || result.uiViewPath.startsWith("//"))
  )
    return null;
  return result;
}
