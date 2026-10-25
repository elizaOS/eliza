/** Shares the host's native Clock boundary with the request view without exporting credentials or scheduling alarms in the renderer. */
import type {
  ClockAlarmContext,
  ClockAlarmOperation,
  ClockAlarmRecord,
  ClockAlarmResult,
  ClockOperation,
  ClockResult,
} from "@elizaos/plugin-assistant/device-clock-review";

export interface ClockStatus {
  supported: boolean;
  agentBase: string | null;
  reason: string | null;
  capabilities: string[];
  scope: string | null;
  installationId: string | null;
  context:
    | ClockAlarmContext
    | { sensitive: false; revision: number; timeZone: string }
    | null;
}
export interface ClockAlarmStatus {
  available: boolean;
  reason: string | null;
  owner: string | null;
  alarmsRevision: number | null;
  alarmsObservedAt: number;
  timeZone: string;
  alarms: ClockAlarmRecord[] | null;
  exactAlarmsAllowed: boolean;
  notificationsAllowed: boolean;
  fullScreenAllowed: boolean;
  alarmSoundMuted: boolean;
  defaultToneAvailable: boolean;
}
export interface ClockProposal {
  id: string;
  digest: string;
  state: string;
  expiresAt: string;
  operation: ClockOperation;
}
export interface ClockHost {
  alarmStatus?(): Promise<ClockAlarmStatus>;
  manageAlarm?(
    operation: ClockAlarmOperation,
    alarmsRevision: number,
    owner: string,
  ): Promise<{ result: ClockAlarmResult; alarmsRevision: number }>;
  requestAlarmPermission?(
    permission: "exact" | "notifications" | "fullScreen",
  ): Promise<void>;
  status(): Promise<ClockStatus>;
  proposals(): Promise<{ scope: string; proposals: ClockProposal[] }>;
  review(
    proposal: ClockProposal,
    scope: string,
    signal: AbortSignal,
  ): Promise<{ handoff: ClockResult; receiptPending: boolean }>;
  subscribe(listener: () => void): () => void;
  retire(): Promise<void>;
}
let host: ClockHost | null = null;
const listeners = new Set<() => void>();
export function configureClockHost(value: ClockHost): void {
  if (host && host !== value)
    throw new Error("Retire the previous Clock owner before replacing it");
  host = value;
  for (const listener of listeners) listener();
}
export function getClockHost(): ClockHost | null {
  return host;
}
export function subscribeClockHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function retireClockHost(value: ClockHost): Promise<void> {
  if (host !== value) throw new Error("Clock host identity changed");
  await value.retire();
  host = null;
  for (const listener of listeners) listener();
}
