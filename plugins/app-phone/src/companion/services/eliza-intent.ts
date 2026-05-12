import { registerPlugin, WebPlugin } from "@capacitor/core";
import { logger } from "./logger";

/**
 * Eliza Intent Plugin — TypeScript facade for the native iOS bridge.
 *
 * On a real device, method calls are routed to `ElizaIntentPlugin.swift`
 * which talks to `UNUserNotificationCenter`, the device-bus subscriber,
 * and `UserDefaults` for pairing persistence. On web (Vite dev / vitest) the fallback below is
 * used — it does not simulate success. It reports `paired: false`, logs
 * each invocation, and rejects native-only calls so dev builds cannot
 * appear to "work" without iOS.
 */

export interface ScheduleAlarmOptions {
  timeIso: string;
  title: string;
  body: string;
}

export interface ScheduleAlarmResult {
  scheduledId: string;
  timeIso: string;
}

export interface ReceiveIntentPayload {
  kind: "alarm" | "reminder" | "block" | "chat";
  payload: Record<string, unknown>;
  issuedAtIso: string;
}

export interface ReceiveIntentResult {
  accepted: boolean;
  reason: string;
}

export interface PairingStatus {
  paired: boolean;
  agentUrl: string | null;
  deviceId: string | null;
}

export interface SetPairingStatusOptions {
  /** Paired agent id from the QR / push payload (stored under `pairingDeviceIdKey` on iOS). */
  deviceId: string;
  /** Session ingress URL (stored under `pairingAgentUrlKey` on iOS). */
  agentUrl: string;
}

export interface ElizaIntentPlugin {
  scheduleAlarm(options: ScheduleAlarmOptions): Promise<ScheduleAlarmResult>;
  receiveIntent(intent: ReceiveIntentPayload): Promise<ReceiveIntentResult>;
  getPairingStatus(): Promise<PairingStatus>;
  setPairingStatus(options: SetPairingStatusOptions): Promise<{ ok: boolean }>;
}

/**
 * Web fallback. Explicitly absent: does not schedule anything, does not
 * pretend to be paired. This lets `bun run dev` boot without a simulator
 * while keeping developers honest about what works.
 */
export class ElizaIntentWeb extends WebPlugin implements ElizaIntentPlugin {
  async scheduleAlarm(
    options: ScheduleAlarmOptions,
  ): Promise<ScheduleAlarmResult> {
    logger.warn("[ElizaIntentWeb] scheduleAlarm not supported on web", {
      options,
    });
    throw this.unavailable(
      "ElizaIntent.scheduleAlarm requires iOS native runtime (UNUserNotificationCenter).",
    );
  }

  async receiveIntent(
    intent: ReceiveIntentPayload,
  ): Promise<ReceiveIntentResult> {
    logger.info("[ElizaIntentWeb] receiveIntent observed (web fallback)", {
      kind: intent.kind,
      issuedAtIso: intent.issuedAtIso,
    });
    return {
      accepted: false,
      reason: "web-fallback: no native intent bus available",
    };
  }

  async getPairingStatus(): Promise<PairingStatus> {
    logger.debug("[ElizaIntentWeb] getPairingStatus", {});
    return {
      paired: false,
      agentUrl: null,
      deviceId: null,
    };
  }

  async setPairingStatus(
    options: SetPairingStatusOptions,
  ): Promise<{ ok: boolean }> {
    logger.debug("[ElizaIntentWeb] setPairingStatus (no-op on web)", {
      deviceIdLength: options.deviceId.length,
      agentUrlHost: (() => {
        try {
          return new URL(options.agentUrl).host;
        } catch {
          return "invalid-url";
        }
      })(),
    });
    return { ok: true };
  }
}

export const ElizaIntent = registerPlugin<ElizaIntentPlugin>("ElizaIntent", {
  web: () => new ElizaIntentWeb(),
});
