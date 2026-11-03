import { withTimeout } from "./net.ts";

export type RepairStage = "rpc" | "price" | "swap" | "ws";

export interface StageClock {
  stage: RepairStage;
  startedAt: number;
  limitMs: number;
}

export function stageExpired(clock: StageClock, now = Date.now()): boolean {
  return now - clock.startedAt >= clock.limitMs;
}

export class CircuitBreaker {
  failures = 0;
  openUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 30_000
  ) {}

  fail(now = Date.now()): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openUntil = now + this.cooldownMs;
  }

  /** A closed breaker allows the call. An open breaker pauses new buys. */
  allow(now = Date.now()): boolean {
    if (this.openUntil === 0) return true;
    if (now >= this.openUntil) {
      this.failures = 0;
      this.openUntil = 0;
      return true;
    }
    return false;
  }
}

/** Chain errors stay unknown. They are never stored as zero. */
export function reconcileAmount(chain: number | "error" | null): number | "unknown" {
  if (chain === "error" || chain == null || !Number.isFinite(chain)) return "unknown";
  return chain;
}

export function reconcileIds(
  localIds: string[],
  chainIds: string[] | "error"
): { ids: string[] | "unknown"; mismatch: boolean } {
  if (chainIds === "error") return { ids: "unknown", mismatch: true };
  const local = [...localIds].sort().join("|");
  const chain = [...chainIds].sort().join("|");
  return { ids: chainIds, mismatch: local !== chain };
}

export class SignatureGuard {
  private readonly seen = new Set<string>();

  /** A timed-out send that later lands is recorded. A second send of that signature is blocked. */
  track(signature: string): "new" | "duplicate" {
    if (this.seen.has(signature)) return "duplicate";
    this.seen.add(signature);
    return "new";
  }
}

export function crashRecoveryAllowed(
  openPositions: number,
  inflight: number
): { ok: boolean; reason: string } {
  if (openPositions > 0)
    return { ok: false, reason: "Open positions stay put. The loop was not restarted." };
  if (inflight > 0)
    return { ok: false, reason: "A send is still in flight. The loop was not restarted." };
  return { ok: true, reason: "No positions were open and nothing was in flight." };
}

export function healthScore(input: {
  stalled: boolean;
  breakerOpen: boolean;
  unknownBalance: boolean;
  mismatch: boolean;
  providerFails: number;
}): { score: number; label: "healthy" | "degraded" | "critical" } {
  let score = 100;
  if (input.stalled) score -= 40;
  if (input.breakerOpen) score -= 25;
  if (input.unknownBalance) score -= 15;
  if (input.mismatch) score -= 15;
  score -= Math.min(20, Math.max(0, input.providerFails) * 5);
  const clamped = Math.max(0, Math.min(100, score));
  const label = clamped >= 80 ? "healthy" : clamped >= 50 ? "degraded" : "critical";
  return { score: clamped, label };
}

export interface Incident {
  t: string;
  title: string;
  before: number;
  after: number;
  layer: 1 | 2;
  applied: boolean;
}

export class IncidentLog {
  readonly events: Incident[] = [];

  add(event: Omit<Incident, "t"> & { t?: string }): Incident {
    const row: Incident = {
      t: event.t ?? new Date().toISOString(),
      title: event.title,
      before: event.before,
      after: event.after,
      layer: event.layer,
      applied: event.applied,
    };
    this.events.unshift(row);
    if (this.events.length > 40) this.events.length = 40;
    return row;
  }
}

/** Try providers in order. A hung call times out and the next provider is used. */
export async function failover<T>(
  providers: string[],
  run: (provider: string) => Promise<T>,
  limitMs: number
): Promise<{ value: T; provider: string; failed: string[] }> {
  const failed: string[] = [];
  let last = "no provider";
  for (const provider of providers) {
    try {
      const value = await withTimeout(run(provider), limitMs, provider);
      return { value, provider, failed };
    } catch (err) {
      failed.push(provider);
      last = err instanceof Error ? err.message : "failed";
    }
  }
  throw new Error(last);
}

export const SAFE_ACTIONS = [
  "switch_provider",
  "raise_timeout",
  "pause_buys",
  "reconnect",
  "restart_if_flat",
  "config_tweak",
] as const;

export type SafeAction = (typeof SAFE_ACTIONS)[number];

export interface RepairProposal {
  action: SafeAction | "code_change" | "refused";
  summary: string;
  applied: false;
  needsConfirm: boolean;
  patch: string | null;
  timeoutMs?: number;
}

const REFUSE =
  /disable (the )?(safety|rug|stop)|loosen|withdraw|send funds|private key|seed phrase/i;

export function classifyIncident(logs: string[]): { kind: string; report: string } {
  const text = logs.join("\n").toLowerCase();
  if (text.includes("signature") || text.includes("landed")) {
    return { kind: "late_send", report: "A send timed out and then landed. Do not send it again." };
  }
  if (text.includes("timed out") || text.includes("hung")) {
    return { kind: "hung_rpc", report: "A network call hung. The next provider can be used." };
  }
  if (text.includes("socket") || text.includes("websocket") || text.includes("dropped")) {
    return {
      kind: "dropped_ws",
      report: "The live stream dropped. Reconnect. Do not treat the book as empty.",
    };
  }
  if (text.includes("balance")) {
    return {
      kind: "balance_error",
      report: "The balance read failed. The amount is unknown, not zero.",
    };
  }
  return {
    kind: "unknown",
    report: "The logs do not name a known fault. No automatic change was made.",
  };
}

export function proposeFix(logs: string[], currentTimeoutMs = 8_000): RepairProposal {
  const joined = logs.join("\n");
  if (REFUSE.test(joined)) {
    return {
      action: "refused",
      summary: "Refused. The agent cannot touch keys, safeguards, stops, or funds.",
      applied: false,
      needsConfirm: false,
      patch: null,
    };
  }
  if (/pull request|code change|patch the source/i.test(joined)) {
    return {
      action: "code_change",
      summary: "A code change is staged for a human pull request. It was not applied.",
      applied: false,
      needsConfirm: false,
      patch: "Review the logs and open a pull request. Do not apply this from the agent.",
    };
  }
  const incident = classifyIncident(logs);
  if (incident.kind === "hung_rpc") {
    const timeoutMs = Math.min(20_000, Math.max(1_000, currentTimeoutMs * 2));
    return {
      action: "raise_timeout",
      summary: `${incident.report} Proposed timeout ${timeoutMs} ms. Waiting for your confirm.`,
      applied: false,
      needsConfirm: true,
      patch: null,
      timeoutMs,
    };
  }
  if (incident.kind === "dropped_ws") {
    return {
      action: "reconnect",
      summary: `${incident.report} Waiting for your confirm.`,
      applied: false,
      needsConfirm: true,
      patch: null,
    };
  }
  if (incident.kind === "late_send") {
    return {
      action: "pause_buys",
      summary: `${incident.report} Pause new buys until you confirm.`,
      applied: false,
      needsConfirm: true,
      patch: null,
    };
  }
  if (incident.kind === "balance_error") {
    return {
      action: "switch_provider",
      summary: `${incident.report} Switch provider after you confirm.`,
      applied: false,
      needsConfirm: true,
      patch: null,
    };
  }
  return {
    action: "restart_if_flat",
    summary: "Restart only if nothing is open and nothing is in flight. Waiting for your confirm.",
    applied: false,
    needsConfirm: true,
    patch: null,
  };
}

export function confirmRepair(
  proposal: RepairProposal,
  confirm: boolean,
  openPositions: number,
  inflight: number
): { applied: boolean; reason: string } {
  if (proposal.action === "code_change" || proposal.action === "refused") {
    return { applied: false, reason: proposal.summary };
  }
  if (!confirm) return { applied: false, reason: "Confirm the repair in the app before it runs." };
  if (proposal.action === "restart_if_flat") {
    const allowed = crashRecoveryAllowed(openPositions, inflight);
    return { applied: allowed.ok, reason: allowed.reason };
  }
  if (proposal.action === "raise_timeout") {
    const next = proposal.timeoutMs ?? 0;
    if (next < 1_000 || next > 20_000)
      return { applied: false, reason: "Timeout stays between 1 and 20 seconds." };
    return { applied: true, reason: `Timeout set to ${next} ms.` };
  }
  return { applied: true, reason: proposal.summary };
}
