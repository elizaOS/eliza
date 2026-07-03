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
 * ROBUSTNESS: the deploy is already running server-side once the gate starts,
 * so a transient status-poll failure (network blip, 5xx, HTTP timeout) must
 * NOT abort the gate — it is logged via `onPollError` and the gate keeps
 * polling until the overall attempt budget runs out, at which point it returns
 * the honest "still building" timeout result (never a claim of done). Every
 * poll is also bounded by a per-request timeout (`requestTimeoutMs`): the dep
 * receives an AbortSignal to tear down the stalled connection, and the gate
 * additionally races the call so even a signal-ignoring dep can never wedge it.
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
  /**
   * Per-request HTTP timeout for each Cloud API call the gate makes (the status
   * poll + the app re-read), so one stalled connection can never hang a poll —
   * let alone the gate — indefinitely.
   */
  requestTimeoutMs: number;
  /** Health path probed after READY. */
  healthPath: string;
}

export interface DeployGateDeps {
  /**
   * `client.getAppDeployStatus(id)` — thread the per-poll `signal` into the
   * HTTP request so a stalled connection is actually torn down at the
   * `requestTimeoutMs` budget (the gate also races the call, so a dep that
   * ignores the signal still can't hang it).
   */
  getStatus: (signal: AbortSignal) => Promise<AppDeployStatusResponse>;
  /**
   * `client.getApp(id)` — re-read to get the authoritative production_url.
   * Receives the same per-request abort signal as `getStatus`.
   */
  getApp: (signal: AbortSignal) => Promise<AppResponse>;
  /** Probe a fully-qualified URL for reachability. */
  probe: (url: string) => Promise<ReachabilityResult>;
  /** Sleep between polls (injected so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress hook for streaming "still building…" updates. */
  onProgress?: (status: string, attempt: number) => void;
  /**
   * Optional hook fired when one status poll fails transiently (network error,
   * HTTP timeout). The gate logs-and-continues — it never aborts on a poll
   * error, because the deploy is still running server-side.
   */
  onPollError?: (error: unknown, attempt: number) => void;
}

/** Production defaults: ~ up to ~2 min of polling with capped backoff. */
export const DEFAULT_DEPLOY_GATE_CONFIG: DeployGateConfig = {
  maxAttempts: 24,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
  probeTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
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

/**
 * Run one injected network call under a hard per-request budget. The dep gets
 * an `AbortSignal` (threaded into `fetch` so the stalled connection is actually
 * torn down), and the call is ALSO raced against the same deadline — so even an
 * implementation that ignores the signal can never hang the gate.
 */
function callWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const attempt = Promise.resolve(call(controller.signal));
  // If the deadline wins, the in-flight call may still reject later (e.g. the
  // aborted fetch) — swallow that so it never surfaces as an unhandled rejection.
  attempt.catch(() => {});
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

export async function runDeployGate(
  deps: DeployGateDeps,
  config: DeployGateConfig = DEFAULT_DEPLOY_GATE_CONFIG,
): Promise<DeployGateResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastStatus = "";
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    let statusRes: AppDeployStatusResponse | undefined;
    try {
      statusRes = await callWithTimeout(
        deps.getStatus,
        config.requestTimeoutMs,
        "deploy status poll",
      );
    } catch (err) {
      // A transient poll failure must NOT abort the gate — the deploy is
      // already running server-side. Log it and keep polling until the
      // overall attempt budget runs out (which reports "still building",
      // never a claim of done).
      deps.onPollError?.(err, attempt);
    }

    if (statusRes) {
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
        return finishReady(deps, config, statusRes, lastStatus, attempt);
      }
    }

    // pending or failed poll — wait then retry (skip the final wait so the
    // loop exits straight to the honest timeout result)
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

/** READY observed — resolve the authoritative URL and run the reachability leg. */
async function finishReady(
  deps: DeployGateDeps,
  config: DeployGateConfig,
  statusRes: AppDeployStatusResponse,
  lastStatus: string,
  attempt: number,
): Promise<DeployGateResult> {
  // Authoritative URL is the app row's production_url (deriveAppPublicUrl),
  // NOT the create/deploy response. Fall back to the status' vercelUrl only
  // if the re-read fails or hasn't populated production_url yet.
  let url = normalizeUrl(statusRes.vercelUrl);
  try {
    const { app } = await callWithTimeout(
      deps.getApp,
      config.requestTimeoutMs,
      "app re-read",
    );
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
