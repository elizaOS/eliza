import { registerPlugin, WebPlugin } from "@capacitor/core";
import { logger } from "./logger";

/**
 * Milady Intent Plugin — TypeScript facade for the native iOS bridge.
 *
 * On a real device, method calls are routed to `MiladyIntentPlugin.swift`
 * which talks to `UNUserNotificationCenter`, the device-bus subscriber,
 * and the pairing store. On web (Vite dev / vitest) the fallback below is
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

export interface MiladyIntentPlugin {
  scheduleAlarm(options: ScheduleAlarmOptions): Promise<ScheduleAlarmResult>;
  receiveIntent(intent: ReceiveIntentPayload): Promise<ReceiveIntentResult>;
  getPairingStatus(): Promise<PairingStatus>;
}

/**
 * Web fallback. Explicitly absent: does not schedule anything, does not
 * pretend to be paired. This lets `bun run dev` boot without a simulator
 * while keeping developers honest about what works.
 */
export class MiladyIntentWeb extends WebPlugin implements MiladyIntentPlugin {
  async scheduleAlarm(
    options: ScheduleAlarmOptions,
  ): Promise<ScheduleAlarmResult> {
    logger.warn("[MiladyIntentWeb] scheduleAlarm not supported on web", {
      options,
    });
    throw this.unavailable(
      "MiladyIntent.scheduleAlarm requires iOS native runtime (UNUserNotificationCenter).",
    );
  }

  async receiveIntent(
    intent: ReceiveIntentPayload,
  ): Promise<ReceiveIntentResult> {
    logger.info("[MiladyIntentWeb] receiveIntent observed (web fallback)", {
      kind: intent.kind,
      issuedAtIso: intent.issuedAtIso,
    });
    return {
      accepted: false,
      reason: "web-fallback: no native intent bus available",
    };
  }

  async getPairingStatus(): Promise<PairingStatus> {
    logger.debug("[MiladyIntentWeb] getPairingStatus", {});
    return {
      paired: false,
      agentUrl: null,
      deviceId: null,
    };
  }
}

export const MiladyIntent = registerPlugin<MiladyIntentPlugin>("MiladyIntent", {
  web: () => new MiladyIntentWeb(),
});
