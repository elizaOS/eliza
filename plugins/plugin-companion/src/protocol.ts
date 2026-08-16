/**
 * Wire contract for the ESP32 companion device bridge: the JSON frames the
 * device (WebSocket server) sends to the plugin (client) and the host commands
 * the plugin sends back. Every inbound frame crosses this trust boundary
 * exactly once — `parseDeviceFrame` either yields a fully typed frame or
 * throws a typed `ElizaError`; no downstream code touches raw JSON. The
 * device speaks: `welcome`, `register`, `commandResult`, `event`
 * (`touch` / `mood_changed`), and `pong`; the host sends `SET_MOOD`,
 * `GET_STATUS`, and `ping`.
 */
import { ElizaError } from "@elizaos/core";

/** First frame the device sends after accepting the socket. */
export interface WelcomeFrame {
  type: "welcome";
  protocol?: string;
}

/** Device identity frame; a device without a `deviceId` is not connected. */
export interface RegisterFrame {
  type: "register";
  deviceId: string;
  firmware?: string;
  capabilities: Record<string, unknown>;
}

/** Correlated response to a host `SET_MOOD` / `GET_STATUS` command. */
export interface CommandResultFrame {
  type: "commandResult";
  correlationId: string;
  ok: boolean;
  error?: string;
  mood?: string;
  status?: Record<string, unknown>;
}

/** Spontaneous device event (touch sensor, mood transition). */
export interface EventFrame {
  type: "event";
  event: string;
  mood?: string;
  data?: Record<string, unknown>;
}

/** Keepalive reply to a host `ping`. */
export interface PongFrame {
  type: "pong";
  at?: number;
}

export type DeviceFrame =
  | WelcomeFrame
  | RegisterFrame
  | CommandResultFrame
  | EventFrame
  | PongFrame;

/** Host command names accepted by the device firmware. */
export type CompanionCommand = "SET_MOOD" | "GET_STATUS";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function badFrame(reason: string, raw: string): ElizaError {
  return new ElizaError(`companion device sent an invalid frame: ${reason}`, {
    code: "COMPANION_BAD_FRAME",
    context: { reason, raw: raw.slice(0, 256) },
  });
}

/**
 * Parses one raw WebSocket text payload into a typed device frame. Throws
 * `ElizaError(COMPANION_BAD_FRAME)` on malformed JSON, a missing/unknown
 * `type`, or a frame whose required fields are absent or mistyped.
 */
export function parseDeviceFrame(raw: string): DeviceFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J2 wrap the untyped JSON.parse failure as a typed frame error.
    throw new ElizaError("companion device sent malformed JSON", {
      code: "COMPANION_BAD_FRAME",
      context: { raw: raw.slice(0, 256) },
      cause: error,
    });
  }
  if (!isRecord(parsed)) throw badFrame("frame is not an object", raw);
  const type = nonEmptyString(parsed.type);
  switch (type) {
    case "welcome":
      return { type, protocol: nonEmptyString(parsed.protocol) };
    case "register": {
      const deviceId = nonEmptyString(parsed.deviceId);
      if (!deviceId) throw badFrame("register frame lacks deviceId", raw);
      return {
        type,
        deviceId,
        firmware: nonEmptyString(parsed.firmware),
        capabilities: isRecord(parsed.capabilities) ? parsed.capabilities : {},
      };
    }
    case "commandResult": {
      const correlationId = nonEmptyString(parsed.correlationId);
      if (!correlationId) {
        throw badFrame("commandResult lacks correlationId", raw);
      }
      if (typeof parsed.ok !== "boolean") {
        throw badFrame("commandResult lacks boolean ok", raw);
      }
      return {
        type,
        correlationId,
        ok: parsed.ok,
        error: nonEmptyString(parsed.error),
        mood: nonEmptyString(parsed.mood),
        status: isRecord(parsed.status) ? parsed.status : undefined,
      };
    }
    case "event": {
      const event = nonEmptyString(parsed.event);
      if (!event) throw badFrame("event frame lacks event name", raw);
      return {
        type,
        event,
        mood: nonEmptyString(parsed.mood),
        data: isRecord(parsed.data) ? parsed.data : undefined,
      };
    }
    case "pong":
      return {
        type,
        at: typeof parsed.at === "number" ? parsed.at : undefined,
      };
    default:
      throw badFrame(`unknown frame type ${String(parsed.type)}`, raw);
  }
}
