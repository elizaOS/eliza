/**
 * Non-JSX support for the in-chat permission card: display labels per permission
 * id, default/parse helpers for permission state and feature refs, a client-side
 * `IPermissionsRegistry` implementation backed by an injected permission client,
 * and a parser that recovers a structured permission request from agent text.
 * Consumed by permission-card.tsx.
 */
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/core/protocol";
import { isPermissionId } from "@elizaos/core/protocol";
/**
 * Friendly human-readable labels per permission id. Used as the card title
 * (e.g. `reminders` → "Apple Reminders").
 */
export const PERMISSION_LABELS: Record<PermissionId, string> = {
  accessibility: "Accessibility",
  "screen-recording": "Screen Recording",
  microphone: "Microphone",
  camera: "Camera",
  shell: "Shell",
  "website-blocking": "Website Blocking",
  location: "Location",
  reminders: "Apple Reminders",
  calendar: "Apple Calendar",
  health: "Apple Health",
  screentime: "Screen Time",
  contacts: "Contacts",
  notes: "Apple Notes",
  notifications: "Notifications",
  "full-disk": "Full Disk Access",
  automation: "Automation",
  "speech-recognition": "Speech Recognition",
  photos: "Photos",
  phone: "Phone",
  messages: "Messages",
  wifi: "Wi-Fi Scans",
  bluetooth: "Bluetooth",
  "app-blocking": "App Blocking",
  "usage-access": "Usage Access",
  overlay: "Draw Over Apps",
  "write-settings": "Write Settings",
  "local-network": "Local Network",
  "battery-optimization": "Battery Optimization",
};
export function getPermissionLabel(id: PermissionId): string {
  return PERMISSION_LABELS[id] ?? id;
}
/**
 * Result emitted to the agent when the user picks the fallback option. The
 * chat host turns this into a system-tagged user message:
 *   `__permission_card__:use_fallback feature=<feature>`
 *
 * The agent's lifeops fallback flow already recognises this prefix; see the
 * `system-prompt-action-block.md` doc and the lifeops permission router. We
 * chose a system-tagged message (vs a custom WS event) so it goes through
 * the existing planner pipeline and lands in the trajectory log without any
 * out-of-band wiring.
 */
export interface PermissionCardFallbackChoice {
  type: "use_fallback";
  feature: string;
  permission: PermissionId;
}
export interface PermissionCardLabels {
  grantAccess?: string;
  upgradeAccess?: string;
  openSettings?: string;
  notNow?: string;
  comingSoon?: string;
  unavailable?: string;
  granted?: string;
  granting?: string;
}
export function defaultStateFor(id: PermissionId): PermissionState {
  const platform =
    typeof navigator !== "undefined" && /Win/i.test(navigator.platform ?? "")
      ? "win32"
      : typeof navigator !== "undefined" &&
          /Linux/i.test(navigator.platform ?? "")
        ? "linux"
        : "darwin";
  return {
    id,
    status: "not-determined",
    lastChecked: 0,
    canRequest: true,
    platform,
  };
}
export function parseFeatureRef(feature: string): {
  app: string;
  action: string;
} {
  // Wire format is `<app>.<area>.<action>` — collapse area+action into the
  // registry's `{ app, action }` ref.
  const parts = feature.split(".");
  const app = parts[0] ?? "unknown";
  const action = parts.slice(1).join(".") || "unknown";
  return { app, action };
}
export interface PermissionClientLike {
  getPermission(id: PermissionId): Promise<PermissionState>;
  requestPermission(id: PermissionId): Promise<PermissionState>;
}
export function createClientPermissionsRegistry(
  clientLike: PermissionClientLike,
): IPermissionsRegistry {
  const states = new Map<PermissionId, PermissionState>();
  const subscribers = new Set<(state: PermissionState[]) => void>();
  const notify = () => {
    const snapshot = Array.from(states.values());
    for (const subscriber of subscribers) {
      subscriber(snapshot);
    }
  };
  const commit = (state: PermissionState) => {
    states.set(state.id, state);
    notify();
    return state;
  };
  return {
    get(id) {
      return states.get(id) ?? defaultStateFor(id);
    },
    async check(id) {
      return commit(await clientLike.getPermission(id));
    },
    async request(id, opts) {
      const next = await clientLike.requestPermission(id);
      return commit({
        ...next,
        lastBlockedFeature: next.lastBlockedFeature ?? {
          app: opts.feature.app,
          action: opts.feature.action,
          at: Date.now(),
        },
      });
    },
    async openSettings() {
      return false;
    },
    recordBlock(id, feature) {
      const current = states.get(id) ?? defaultStateFor(id);
      commit({
        ...current,
        lastBlockedFeature: {
          app: feature.app,
          action: feature.action,
          at: Date.now(),
        },
      });
    },
    list() {
      return Array.from(states.values());
    },
    pending() {
      return Array.from(states.values()).filter(
        (state) =>
          state.status === "not-determined" ||
          Boolean(state.lastBlockedFeature),
      );
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    registerProber() {
      // UI adapter delegates probing to the backend/native bridge.
    },
  };
}
/**
 * Render-helper invoked by the chat transcript's `renderMessageContent` hook
 * when the message text contains a parsed permission_request block. The host
 * passes the parsed payload, the registry, and message-level callbacks.
 */
export interface PermissionCardPayload {
  permission: PermissionId;
  reason: string;
  feature: string;
  fallbackOffered?: boolean;
  fallbackLabel?: string;
}
/**
 * Minimal UI-side parser for `permission_request` action blocks. Mirrors the
 * server-side `parseActionBlock` output for `permission_request` so the
 * chat surface can render the inline card without pulling in `@elizaos/agent`.
 *
 * Returns `null` for any other action block (`respond`, `escalate`,
 * `ignore`, `complete`) so the caller can fall back to plain text rendering.
 */
function readJsonObject(
  text: string,
  open: number,
): { end: number; value: unknown } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return { end: i + 1, value: JSON.parse(text.slice(open, i + 1)) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function skipFenceWhitespace(text: string, index: number): number {
  let cursor = index;
  let count = 0;
  while (cursor < text.length && count < 33 && /\s/.test(text[cursor] ?? "")) {
    cursor++;
    count++;
  }
  return cursor;
}

function findPermissionRequestSpan(text: string): {
  start: number;
  end: number;
  value: Record<string, unknown>;
} | null {
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("```", cursor);
    if (open < 0) break;
    let body = open + 3;
    if (text.startsWith("json", body)) body += 4;
    body = skipFenceWhitespace(text, body);
    const object = text[body] === "{" ? readJsonObject(text, body) : null;
    const value = object?.value;
    if (
      object &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { action?: unknown }).action === "permission_request"
    ) {
      const close = skipFenceWhitespace(text, object.end);
      if (text.startsWith("```", close)) {
        return {
          start: open,
          end: close + 3,
          value: value as Record<string, unknown>,
        };
      }
    }
    cursor = open + 3;
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const object = readJsonObject(text, i);
    const value = object?.value;
    if (
      !object ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { action?: unknown }).action !== "permission_request"
    ) {
      continue;
    }
    return {
      start: i,
      end: object.end,
      value: value as Record<string, unknown>,
    };
  }
  return null;
}

export function parsePermissionRequestFromText(text: string): {
  display: string;
  payload: PermissionCardPayload;
} | null {
  if (!text) return null;
  const span = findPermissionRequestSpan(text);
  if (!span) return null;
  const display = (text.slice(0, span.start) + text.slice(span.end)).trim();
  const parsed = span.value;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (
      parsed as {
        action?: unknown;
      }
    ).action !== "permission_request"
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const permission = record.permission;
  const reason = record.reason;
  const feature = record.feature;
  if (
    !isPermissionId(permission) ||
    typeof reason !== "string" ||
    typeof feature !== "string"
  ) {
    return null;
  }
  const payload: PermissionCardPayload = {
    permission,
    reason,
    feature,
    fallbackOffered: record.fallback_offered === true,
    ...(typeof record.fallback_label === "string" &&
    record.fallback_label.length > 0
      ? { fallbackLabel: record.fallback_label }
      : {}),
  };
  return { display, payload };
}
