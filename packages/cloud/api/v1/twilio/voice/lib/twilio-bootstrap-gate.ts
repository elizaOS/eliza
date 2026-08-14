/** Bounds unauthenticated Twilio Media Stream sockets until their signed start frame arrives. */

const DEFAULT_MAX_PENDING_BOOTSTRAPS = 32;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const MAX_PENDING_BOOTSTRAPS = 256;
const MAX_BOOTSTRAP_TIMEOUT_MS = 60_000;

export interface TwilioBootstrapLimits {
  maxPending: number;
  timeoutMs: number;
}

export interface TwilioBootstrapLease {
  release(): void;
}

function parseBoundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return null;
  return value;
}

export function resolveTwilioBootstrapLimits(env: {
  TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS?: string;
  TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS?: string;
}): TwilioBootstrapLimits | null {
  const maxPending = parseBoundedPositiveInteger(
    env.TWILIO_VOICE_MAX_PENDING_BOOTSTRAPS,
    DEFAULT_MAX_PENDING_BOOTSTRAPS,
    MAX_PENDING_BOOTSTRAPS,
  );
  const timeoutMs = parseBoundedPositiveInteger(
    env.TWILIO_VOICE_BOOTSTRAP_TIMEOUT_MS,
    DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    MAX_BOOTSTRAP_TIMEOUT_MS,
  );
  return maxPending && timeoutMs ? { maxPending, timeoutMs } : null;
}

export class TwilioBootstrapGate {
  private pending = 0;

  tryAcquire(limit: number): TwilioBootstrapLease | null {
    if (this.pending >= limit) return null;
    this.pending += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pending -= 1;
      },
    };
  }

  pendingCount(): number {
    return this.pending;
  }
}
