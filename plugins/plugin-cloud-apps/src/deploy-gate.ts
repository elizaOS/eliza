/**
 * The DEPLOY_APP completion gate.
 *
 * "Done" is not "the deploy was accepted (202)". The gate runs two checks:
 *   1. COMPLETION — poll `getAppDeployStatus` until the public status is READY
 *      (bounded retries with exponential backoff + an overall timeout). A
 *      server-reported ERROR/FAILED short-circuits immediately.
 *   2. REACHABILITY — once READY, read the authoritative `production_url` from
 *      the app row (deriveAppPublicUrl semantics — NOT the create response) and
 *      probe `<production_url>/health`, treating any answer EXCEPT a Caddy
 *      gateway error (502/503/504) as reachable — the SAME rule the server uses
 *      to mark the app READY, so the gate never contradicts the server (an
 *      auth-gated 401/403 app, or one with no `/health` route, is still live).
 * Only when BOTH pass do we report the app live.
 *
 * The gate is pure and fully injectable (status fetch, app fetch, probe, sleep)
 * so it can be unit-tested against a mocked status progression + reachability —
 * which is the proof for now: a real end-to-end deploy cannot be verified until
 * the staging deploy backend is armed (#9853 / Phase 4).
 */

import type { AppDeployStatusResponse, AppResponse } from "@elizaos/cloud-sdk";
import {
  healthUrl,
  type ReachabilityResult,
  respondedLive,
} from "./reachability.js";

/** Terminal outcome of the gate. */
export type DeployPhase = "ready" | "error" | "timeout" | "unreachable";

export interface DeployGateResult {
  phase: DeployPhase;
  /** The app's public production URL, when one was resolved. */
  url: string | null;
  /** The last public deploy status string observed. */
  status: string;
  /** How many status polls ran. */
  attempts: number;
  /** The reachability probe result (present once status reached READY). */
  reachability?: ReachabilityResult;
  /** Server-reported error / failure reason, when relevant. */
  error?: string;
}

export interface DeployGateConfig {
  /** Max status polls before declaring a timeout. */
  maxAttempts: number;
  /** First backoff delay (ms). */
  initialDelayMs: number;
  /** Backoff ceiling (ms). */
  maxDelayMs: number;
  /** Per-probe HTTP timeout passed through to the reachability probe (ms). */
  probeTimeoutMs: number;
  /** Health path probed after READY. */
  healthPath: string;
}

export interface DeployGateDeps {
  /** `client.getAppDeployStatus(id)`. */
  getStatus: () => Promise<AppDeployStatusResponse>;
  /** `client.getApp(id)` — re-read to get the authoritative production_url. */
  getApp: () => Promise<AppResponse>;
  /** Probe a fully-qualified URL for reachability. */
  probe: (url: string) => Promise<ReachabilityResult>;
  /** Sleep between polls (injected so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress hook for streaming "still building…" updates. */
  onProgress?: (status: string, attempt: number) => void;
}

/** Production defaults: ~ up to ~2 min of polling with capped backoff. */
export const DEFAULT_DEPLOY_GATE_CONFIG: DeployGateConfig = {
  maxAttempts: 24,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
  probeTimeoutMs: 10_000,
  healthPath: "/health",
};

const TERMINAL_SUCCESS = new Set(["READY", "DEPLOYED"]);
const TERMINAL_ERROR = new Set(["ERROR", "FAILED"]);

type StatusClass = "success" | "error" | "pending";

/**
 * Map the public deploy status to a terminal/pending class. The server's public
 * lifecycle is DRAFT | BUILDING | READY | ERROR (with `deploying` folded into
 * BUILDING); we also accept the `DEPLOYED` synonym defensively.
 */
export function classifyDeployStatus(
  status: string | null | undefined,
): StatusClass {
  const s = (status ?? "").trim().toUpperCase();
  if (TERMINAL_SUCCESS.has(s)) return "success";
  if (TERMINAL_ERROR.has(s)) return "error";
  return "pending";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function runDeployGate(
  deps: DeployGateDeps,
  config: DeployGateConfig = DEFAULT_DEPLOY_GATE_CONFIG,
): Promise<DeployGateResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastStatus = "";
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const statusRes = await deps.getStatus();
    lastStatus = statusRes.status ?? "";
    deps.onProgress?.(lastStatus, attempt);

    const cls = classifyDeployStatus(lastStatus);

    if (cls === "error") {
      return {
        phase: "error",
        url: normalizeUrl(statusRes.vercelUrl),
        status: lastStatus,
        attempts: attempt,
        error: statusRes.error ?? undefined,
      };
    }

    if (cls === "success") {
      // Authoritative URL is the app row's production_url (deriveAppPublicUrl),
      // NOT the create/deploy response. Fall back to the status' vercelUrl only
      // if the re-read fails or hasn't populated production_url yet.
      let url = normalizeUrl(statusRes.vercelUrl);
      try {
        const { app } = await deps.getApp();
        url = normalizeUrl(app?.production_url) ?? url;
      } catch {
        // keep vercelUrl fallback
      }
      if (!url) {
        return {
          phase: "unreachable",
          url: null,
          status: lastStatus,
          attempts: attempt,
          error: "no_production_url",
        };
      }
      const reachability = await deps.probe(healthUrl(url, config.healthPath));
      return respondedLive(reachability)
        ? {
            phase: "ready",
            url,
            status: lastStatus,
            attempts: attempt,
            reachability,
          }
        : {
            phase: "unreachable",
            url,
            status: lastStatus,
            attempts: attempt,
            reachability,
            error: reachability.error,
          };
    }

    // pending — wait then retry (skip the final wait so the loop exits to timeout)
    if (attempt < config.maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, config.maxDelayMs);
    }
  }

  return {
    phase: "timeout",
    url: null,
    status: lastStatus,
    attempts: config.maxAttempts,
  };
}
