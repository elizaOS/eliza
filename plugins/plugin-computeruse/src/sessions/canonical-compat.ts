/**
 * Adapts the legacy computer-use session HTTP DTO to the canonical core v2
 * interaction authority. The compatibility route remains stable for existing
 * callers, while session/surface identity and every dispatch are normalized by
 * `@elizaos/core` before an adapter can observe a side effect.
 */

import {
  authorizeInteractionDispatch,
  INTERACTION_ACTION_KINDS,
  INTERACTION_CONTRACT_VERSION,
  type InteractionActionKind,
  type InteractionCapabilitySet,
  type InteractionSession,
  type InteractionSurfaceKind,
  normalizeInteractionSession,
} from "@elizaos/core";
import type {
  ComputerUseSessionAction,
  ComputerUseSessionSnapshot,
} from "./types.js";

interface CanonicalActionShape {
  kind: InteractionActionKind;
  payload: Record<string, unknown>;
}

function surfaceKind(
  session: ComputerUseSessionSnapshot,
): InteractionSurfaceKind {
  switch (session.target.kind) {
    case "host":
      return "display";
    case "browser":
      return "browser_tab";
    case "sandbox":
    case "remote_guest":
      return "virtual_desktop";
  }
}

function capabilities(
  session: ComputerUseSessionSnapshot,
): InteractionCapabilitySet {
  const kind = surfaceKind(session);
  return {
    contractVersion: INTERACTION_CONTRACT_VERSION,
    adapterId: session.adapterId,
    controlPlanes: [session.target.kind === "browser" ? "browser" : "computer"],
    surfaceKinds: [kind],
    observationChannels:
      session.target.kind === "browser"
        ? ["screenshot", "dom", "browser_accessibility"]
        : ["screenshot", "ocr", "os_accessibility", "window_geometry"],
    actionKinds: INTERACTION_ACTION_KINDS,
    background: {
      mode: session.target.kind === "host" ? "none" : "isolated_session",
      requiresForeground:
        session.target.kind === "host" ? INTERACTION_ACTION_KINDS : [],
    },
    profileAccess: {
      modes: session.target.kind === "browser" ? ["managed"] : ["none"],
      requiresExplicitGrant: false,
    },
    concurrency: {
      mode:
        session.target.kind === "host"
          ? "multi_surface_shared_input"
          : "isolated_sessions",
      maxSessions: session.target.kind === "host" ? 1 : null,
      sharedResources:
        session.target.kind === "host"
          ? ["physical_pointer", "keyboard", "focus", "clipboard"]
          : [],
    },
    limitations: [],
  };
}

export function toCanonicalInteractionSession(
  session: ComputerUseSessionSnapshot,
): InteractionSession {
  const surface = {
    sessionId: session.id,
    adapterId: session.adapterId,
    surfaceId:
      session.target.kind === "host"
        ? "host-display"
        : (session.target.targetId ?? session.target.kind),
    kind: surfaceKind(session),
    generation: session.generation,
    parentSurfaceId: null,
  };
  return normalizeInteractionSession(
    {
      contractVersion: INTERACTION_CONTRACT_VERSION,
      sessionId: session.id,
      ownerId: session.ownerId,
      adapterId: session.adapterId,
      state: session.canonicalState,
      isolationMode: session.isolationMode,
      profileMode: session.target.kind === "browser" ? "managed" : "none",
      generation: session.generation,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.leaseExpiresAt ?? null,
      profileGrant: null,
      surfaces: [surface],
    },
    { capabilities: capabilities(session) },
  );
}

function stringParameter(
  parameters: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function numberParameter(
  parameters: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function pointParameter(
  parameters: Record<string, unknown>,
  key = "coordinate",
): { x: number; y: number } | null {
  const value = parameters[key];
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  ) {
    return { x: value[0], y: value[1] };
  }
  const x = numberParameter(parameters, key === "startCoordinate" ? "x1" : "x");
  const y = numberParameter(parameters, key === "startCoordinate" ? "y1" : "y");
  return x === undefined || y === undefined ? null : { x, y };
}

function pointerPayload(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return {
    elementId:
      stringParameter(parameters, "selector", "ref", "elementId") ?? null,
    point: pointParameter(parameters),
  };
}

function keyPayload(
  command: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const keys = parameters.keys ?? parameters.modifiers ?? parameters.hold_keys;
  const combined = Array.isArray(keys)
    ? keys
        .filter((value): value is string => typeof value === "string")
        .join("+")
    : undefined;
  return {
    key:
      stringParameter(parameters, "key", "text") ??
      (combined && combined.length > 0 ? combined : command),
  };
}

function scrollPayload(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const amount = Math.abs(numberParameter(parameters, "amount") ?? 300);
  const direction =
    stringParameter(parameters, "direction", "scrollDirection") ?? "down";
  return {
    deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
    deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0,
    elementId: stringParameter(parameters, "selector", "elementId") ?? null,
  };
}

function canonicalAction(
  command: string,
  parameters: Record<string, unknown>,
): CanonicalActionShape {
  switch (command) {
    case "screenshot":
    case "browser_screenshot":
    case "browser_dom":
    case "browser_get_dom":
    case "browser_clickables":
    case "browser_get_clickables":
    case "browser_state":
    case "browser_info":
    case "browser_get_context":
    case "browser_list_tabs":
    case "get_cursor_position":
    case "detect_elements":
    case "ocr":
    case "list_windows":
      return { kind: "observe", payload: {} };
    case "click":
    case "click_with_modifiers":
    case "middle_click":
    case "mouse_down":
    case "mouse_up":
    case "browser_click":
      return { kind: "click", payload: pointerPayload(parameters) };
    case "double_click":
      return { kind: "double_click", payload: pointerPayload(parameters) };
    case "right_click":
      return { kind: "context_click", payload: pointerPayload(parameters) };
    case "mouse_move":
      return { kind: "hover", payload: pointerPayload(parameters) };
    case "drag": {
      const path = parameters.path;
      const pathStart =
        Array.isArray(path) && path.length > 0 ? path[0] : undefined;
      const pathEnd =
        Array.isArray(path) && path.length > 0 ? path.at(-1) : undefined;
      return {
        kind: "drag",
        payload: {
          fromElementId: null,
          toElementId: null,
          from:
            Array.isArray(pathStart) && pathStart.length === 2
              ? { x: pathStart[0], y: pathStart[1] }
              : pointParameter(parameters, "startCoordinate"),
          to:
            Array.isArray(pathEnd) && pathEnd.length === 2
              ? { x: pathEnd[0], y: pathEnd[1] }
              : pointParameter(parameters),
        },
      };
    }
    case "scroll":
    case "browser_scroll":
      return { kind: "scroll", payload: scrollPayload(parameters) };
    case "type":
    case "browser_type":
      return {
        kind: "type_text",
        payload: {
          text: parameters.text,
          elementId:
            stringParameter(parameters, "selector", "elementId") ?? null,
          sensitive: parameters.sensitive === true,
        },
      };
    case "set_value":
      return {
        kind: "set_value",
        payload: {
          text: parameters.text ?? parameters.value,
          elementId:
            stringParameter(parameters, "selector", "elementId") ?? null,
          sensitive: parameters.sensitive === true,
        },
      };
    case "key_press":
    case "key_combo":
    case "key_down":
    case "key_up":
      return { kind: "press_key", payload: keyPayload(command, parameters) };
    case "open":
      return {
        kind: "open",
        payload: { url: stringParameter(parameters, "target", "url") },
      };
    case "launch":
      return {
        kind: "launch_app",
        payload: {
          applicationId: stringParameter(parameters, "app", "applicationId"),
        },
      };
    case "kill_app":
      return {
        kind: "quit_app",
        payload: {
          applicationId: stringParameter(parameters, "app", "applicationId"),
        },
      };
    case "browser_open":
    case "browser_connect": {
      const url = stringParameter(parameters, "url");
      return url
        ? { kind: "navigate", payload: { url } }
        : { kind: "launch_app", payload: { applicationId: "managed-browser" } };
    }
    case "browser_navigate":
      return {
        kind: "navigate",
        payload: { url: stringParameter(parameters, "url") },
      };
    case "browser_open_tab":
      return {
        kind: "create_tab",
        payload: { url: stringParameter(parameters, "url") },
      };
    case "browser_close":
      return {
        kind: "quit_app",
        payload: { applicationId: "managed-browser" },
      };
    case "browser_close_tab":
      return { kind: "close_tab", payload: {} };
    case "browser_switch_tab":
      return {
        kind: "switch_tab",
        payload: { tabId: stringParameter(parameters, "tabId") },
      };
    case "browser_execute":
      return { kind: "evaluate", payload: { expression: parameters.code } };
    case "browser_wait":
      return {
        kind: "wait",
        payload: {
          condition:
            stringParameter(parameters, "waitForText", "waitForTextGone") ??
            "browser condition",
          timeoutMs: numberParameter(parameters, "timeout") ?? 10_000,
        },
      };
    case "switch_to_window":
    case "arrange_windows":
    case "minimize_window":
    case "maximize_window":
    case "restore_window":
      return {
        kind: "focus",
        payload: {
          elementId:
            stringParameter(parameters, "windowId", "windowTitle", "appName") ??
            null,
        },
      };
    case "move_window":
      return {
        kind: "move_window",
        payload: { point: pointParameter(parameters) },
      };
    case "close_window":
      return { kind: "close", payload: {} };
    default:
      // Registered sandbox/remote adapters have provider-specific verbs. Core
      // v2 represents their exact opaque request at the generic evaluate seam;
      // the compatibility adapter still owns the eventual allowlist.
      return {
        kind: "evaluate",
        payload: { expression: JSON.stringify({ command, parameters }) },
      };
  }
}

export async function authorizeCompatibilitySessionAction(
  session: ComputerUseSessionSnapshot,
  action: ComputerUseSessionAction,
  now: number,
): Promise<void> {
  const canonicalSession = toCanonicalInteractionSession(session);
  const surface = canonicalSession.surfaces[0];
  if (!surface)
    throw new Error("Canonical computer-use session has no surface");
  const parameters = action.parameters ?? {};
  const mapped =
    session.target.kind === "sandbox" || session.target.kind === "remote_guest"
      ? {
          kind: "evaluate" as const,
          payload: {
            expression: JSON.stringify({ command: action.command, parameters }),
          },
        }
      : canonicalAction(action.command, parameters);
  await authorizeInteractionDispatch(
    {
      contractVersion: INTERACTION_CONTRACT_VERSION,
      actionId: action.actionId,
      sessionId: canonicalSession.sessionId,
      adapterId: canonicalSession.adapterId,
      surface,
      kind: mapped.kind,
      payload: mapped.payload,
      observationId: action.observationId ?? null,
      observationSequence: action.observationSequence ?? null,
      requestedAt: new Date(now).toISOString(),
      confirmationGrant: null,
      leaseIds: [],
    },
    {
      session: canonicalSession,
      capabilities: capabilities(session),
      now,
      leaseRequirements: [],
    },
  );
}
