/**
 * Shared companion protocol frames. Matches firmware PROTOCOL.md:
 * ESP32 is the WebSocket server; Eliza is the client.
 */

export const COMPANION_PROTOCOL = "eliza-companion/1";
export const COMPANION_WS_PATH = "/api/companion/device-bridge";
export const COMPANION_SERVICE_TYPE = "COMPANION_SERVICE";

export const COMPANION_MOODS = ["idle", "listening", "thinking", "happy"] as const;

export type CompanionMood = (typeof COMPANION_MOODS)[number];

export const MOOD_ALIASES: Record<string, CompanionMood> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  happy: "happy",
  ready: "happy",
};

export function normalizeMood(value: string | undefined): CompanionMood | null {
  if (!value) return null;
  return MOOD_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function isCompanionMood(value: unknown): value is CompanionMood {
  return typeof value === "string" && COMPANION_MOODS.includes(value as CompanionMood);
}

export interface CompanionCapabilities {
  platform?: string;
  deviceModel?: string;
  mac?: string;
  display?: boolean;
  touch?: boolean;
}

export interface CompanionRegisterPayload {
  deviceId?: string;
  pairingToken?: string;
  firmware?: string;
  capabilities?: CompanionCapabilities;
}

export type CompanionInbound =
  | { type: "welcome"; payload?: { deviceId?: string; protocol?: string } }
  | { type: "register"; payload: CompanionRegisterPayload }
  | { type: "pong"; at?: number }
  | {
      type: "event";
      name: string;
      payload?: { mood?: string };
    }
  | {
      type: "commandResult";
      correlationId: string;
      ok: boolean;
      error?: string;
      payload?: { mood?: string };
    };

export type CompanionOutbound =
  | { type: "ping"; at: number }
  | {
      type: "command";
      name: "SET_MOOD" | "GET_STATUS";
      correlationId: string;
      payload?: { mood?: CompanionMood };
    };

export type CompanionFrame = CompanionInbound | CompanionOutbound | { type: string };

export function parseFrame(raw: unknown): CompanionFrame | null {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString("utf8")
          : null;
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as CompanionFrame;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildPing(at = Date.now()): CompanionOutbound {
  return { type: "ping", at };
}

export function buildCommand(
  name: "SET_MOOD" | "GET_STATUS",
  correlationId: string,
  payload?: { mood?: CompanionMood }
): CompanionOutbound {
  return {
    type: "command",
    name,
    correlationId,
    ...(payload ? { payload } : {}),
  };
}

export function withPairingToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}
