/**
 * Cloud onboarding flow for Eliza Cloud integration.
 *
 * Handles availability check → browser-based auth → agent provisioning
 * during `runFirstTimeSetup()`. Extracted to keep `eliza.ts` manageable.
 *
 * @module cloud-onboarding
 */

import { logger } from "@elizaos/core";
import type { StylePreset } from "@elizaos/core";
import { type CloudLoginResult, cloudLogin } from "./cloud/auth.js";
import { normalizeCloudSiteUrl } from "./cloud/base-url.js";
import {
  type CloudAgentCreateParams,
  ElizaCloudClient,
} from "./cloud/bridge-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lazy-loaded @clack/prompts module type (matches eliza.ts pattern). */
type ClackModule = typeof import("@clack/prompts");

/** Result of a successful cloud onboarding flow. */
export interface CloudOnboardingResult {
  apiKey: string;
  agentId: string | undefined;
  baseUrl: string;
  bridgeUrl?: string;
}

/**
 * Outcome of the agent-provisioning step. Distinguishes a fully-running
 * agent from one that timed out mid-provisioning so callers do not treat
 * the timeout path as a success.
 */
type ProvisionOutcome =
  | { kind: "running"; agentId: string; bridgeUrl?: string }
  | { kind: "pending-after-timeout"; agentId: string }
  | null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLOUD_BASE_URL = "https://www.elizacloud.ai";
const PROVISION_TIMEOUT_MS = 120_000; // 2 minutes
const PROVISION_POLL_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

/**
 * Quick pre-flight check: is Eliza Cloud accepting new agents?
 * Returns null if available, or an error message string if not.
 */
export async function checkCloudAvailability(
  baseUrl: string,
): Promise<string | null> {
  try {
    const url = `${normalizeCloudSiteUrl(baseUrl)}/api/compat/availability`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return `Cloud returned HTTP ${res.status}. It may be temporarily unavailable.`;
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: { acceptingNewAgents?: boolean; availableSlots?: number };
    };

    if (!body.success || !body.data?.acceptingNewAgents) {
      return "Eliza Cloud is currently at capacity. Try again later or run locally.";
    }

    return null; // Available!
  } catch (err) {
    const msg = String(err);
    if (msg.includes("timed out") || msg.includes("timeout")) {
      return "Could not reach Eliza Cloud (request timed out). Check your internet connection.";
    }
    return `Could not reach Eliza Cloud: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Cloud auth wrapper (with clack UI)
// ---------------------------------------------------------------------------

/**
 * Run the Eliza Cloud browser-based login, wrapped with clack spinners.
 * Returns the API key/result or null if the user wants to fall back.
 */
async function runCloudAuth(
  clack: ClackModule,
  baseUrl: string,
): Promise<CloudLoginResult | null> {
  const spinner = clack.spinner();
  spinner.start("Connecting to Eliza Cloud...");

  try {
    const result = await cloudLogin({
      baseUrl,
      timeoutMs: 300_000, // 5 minutes
      onBrowserUrl: (url: string) => {
        spinner.stop("Opening your browser to log in...");
        clack.log.info(`If the browser didn't open, visit:\n  ${url}`);

        // Try to open the browser
        openBrowser(url).catch(() => {
          // Fallback: user can manually navigate
        });

        // Restart spinner for polling
        spinner.start("Waiting for login in browser...");
      },
      onPollStatus: (status: string) => {
        if (status === "pending") {
          spinner.message("Waiting for login in browser...");
        }
      },
    });

    spinner.stop("✓ Logged in to Eliza Cloud!");
    return result;
  } catch (err) {
    spinner.stop(describeCloudAuthError(err));
    return null;
  }
}

/**
 * Translate the various error categories `cloudLogin` can throw into a
 * single user-facing line. The categories are derived from the strings
 * `cloud/auth.ts` and `cloud/validate-url.ts` already produce — we don't
 * invent new error types, we just steer them into the right bucket.
 */
function describeCloudAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.toLowerCase();

  // Overall 5-minute browser timeout from cloudLogin.
  if (
    msg.includes("login timed out") ||
    msg.includes("not completed within")
  ) {
    return "Cloud sign-in timed out after 5 minutes. Try again or run locally.";
  }

  // validateCloudBaseUrl rejections (HTTPS-only, blocked host, DNS, …).
  if (
    msg.includes("invalid cloud base url") ||
    msg.includes("cloud base url") ||
    msg.includes("could not be resolved via dns")
  ) {
    return `Cloud sign-in failed: ${raw}`;
  }

  // Per-request timeouts (session create / polling) and any fetch network
  // failure from `cloudLogin`.
  if (
    msg.includes("timed out") ||
    msg.includes("failed to create auth session") ||
    msg.includes("polling failed") ||
    msg.includes("polling request timed out")
  ) {
    return "Couldn't reach Eliza Cloud. Check your connection or run locally.";
  }

  // Fallback: surface the underlying message verbatim.
  return `Cloud sign-in failed: ${raw}`;
}

// ---------------------------------------------------------------------------
// Agent provisioning
// ---------------------------------------------------------------------------

/**
 * Create and provision a cloud agent, polling until it's running.
 *
 * Returns a discriminated outcome:
 *   - `{ kind: "running", agentId, bridgeUrl? }` — agent reached a
 *      terminal "up" state.
 *   - `{ kind: "pending-after-timeout", agentId }` — agent was created
 *      but never reached a running/failed terminal status before
 *      `PROVISION_TIMEOUT_MS`. The caller is expected to surface the
 *      timeout to the user; we don't pretend it succeeded.
 *   - `null` — agent creation failed outright, or provisioning failed
 *      with an `error`/`failed` status, or the polling loop hit a
 *      terminal auth error (401/403). The caller falls back.
 */
async function provisionCloudAgent(
  clack: ClackModule,
  client: ElizaCloudClient,
  agentName: string,
  preset?: StylePreset,
): Promise<ProvisionOutcome> {
  const spinner = clack.spinner();
  spinner.start("Creating your cloud agent...");

  let agentId: string;
  let initialStatus: string;
  try {
    const agentConfig: Record<string, unknown> = {};
    if (preset) {
      agentConfig.bio = preset.bio;
      agentConfig.system = preset.system;
      agentConfig.style = preset.style;
      agentConfig.adjectives = preset.adjectives;
      agentConfig.topics = preset.topics;
      agentConfig.postExamples = preset.postExamples;
      agentConfig.messageExamples = preset.messageExamples;
    }

    const params: CloudAgentCreateParams = {
      agentName,
      agentConfig,
    };

    const agent = await client.createAgent(params);
    agentId = agent.id;
    initialStatus = agent.status;
  } catch (err) {
    spinner.stop(`Failed to create cloud agent: ${String(err)}`);
    return null;
  }

  spinner.message("Agent created! Provisioning cloud environment...");

  // Poll for terminal status. Order: poll first (terminal-on-first-read
  // skips the wasted sleep), then sleep at the END of each iteration if
  // the loop has time remaining.
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  let lastStatus = initialStatus;

  while (Date.now() < deadline) {
    let current: Awaited<ReturnType<ElizaCloudClient["getAgent"]>> | null;
    try {
      current = await client.getAgent(agentId);
    } catch (pollErr) {
      const classification = classifyPollError(pollErr);
      if (classification === "auth") {
        spinner.stop(
          `Cloud rejected the API key (last status: ${lastStatus}). Please sign in again.`,
        );
        return null;
      }
      if (classification === "transient") {
        // 5xx / network: keep trying, but at warn level so a sustained
        // outage is visible in logs (not silently buried at debug).
        logger.warn(
          `[cloud-onboarding] Transient poll error, will retry: ${String(pollErr)}`,
        );
        current = null;
      } else {
        // Terminal but not auth — propagate and stop the flow.
        spinner.stop(`Provisioning poll failed: ${String(pollErr)}`);
        return null;
      }
    }

    if (current) {
      lastStatus = current.status;
      switch (lastStatus) {
        case "running":
        case "completed":
          spinner.stop(`☁️  Cloud agent "${agentName}" is running!`);
          return {
            kind: "running",
            agentId,
            bridgeUrl: current.bridgeUrl,
          };

        case "failed":
        case "error":
          spinner.stop(
            `Provisioning failed: ${current.errorMessage ?? "unknown error"}`,
          );
          return null;

        case "queued":
          spinner.message("Queued — waiting for available slot...");
          break;

        case "provisioning":
          spinner.message("Provisioning cloud environment...");
          break;

        default:
          spinner.message(`Status: ${lastStatus}...`);
      }
    }

    // Sleep AFTER the read. If the previous read was terminal we would
    // have returned above; if it pushed us past the deadline the loop
    // condition will exit on the next iteration without another sleep.
    if (Date.now() + PROVISION_POLL_INTERVAL_MS < deadline) {
      await sleep(PROVISION_POLL_INTERVAL_MS);
    } else {
      break;
    }
  }

  // Reached the deadline without a terminal status. Surface that
  // explicitly — callers must not treat this as a success.
  spinner.stop(
    `Provisioning timed out (last status: ${lastStatus}). The agent may still be starting up.`,
  );
  return { kind: "pending-after-timeout", agentId };
}

/**
 * Classify a `getAgent` poll error. The bridge client's `request<T>`
 * surfaces non-2xx responses as plain `Error("HTTP <status>: ...")` from
 * `getAgent` (see `cloud/bridge-client.ts`), so the message-prefix match
 * is the canonical signal.
 *
 *   "auth"      — 401/403: stop polling immediately.
 *   "transient" — 5xx or network/fetch error: keep retrying.
 *   "terminal"  — anything else (404, malformed body, etc.): stop.
 */
function classifyPollError(err: unknown): "auth" | "transient" | "terminal" {
  const raw = err instanceof Error ? err.message : String(err);
  if (/\bHTTP\s+40[13]\b/i.test(raw)) {
    return "auth";
  }
  if (/\bHTTP\s+5\d{2}\b/i.test(raw)) {
    return "transient";
  }
  // AbortError / TimeoutError / fetch failures from the request layer.
  if (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /fetch failed|network|timed out|timeout/i.test(raw))
  ) {
    return "transient";
  }
  return "terminal";
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full cloud onboarding flow:
 * 1. Check availability
 * 2. Authenticate via browser
 * 3. Create + provision agent
 *
 * Returns the result or null if the user cancels / an error occurs.
 * On failure, the caller should fall back to local mode.
 */
export async function runCloudOnboarding(
  clack: ClackModule,
  agentName: string,
  preset?: StylePreset,
  baseUrl?: string,
): Promise<CloudOnboardingResult | null> {
  const resolvedBaseUrl = normalizeCloudSiteUrl(
    baseUrl ?? DEFAULT_CLOUD_BASE_URL,
  );

  // ── Step 1: Availability check ──────────────────────────────────────
  const unavailableReason = await checkCloudAvailability(resolvedBaseUrl);
  if (unavailableReason) {
    clack.log.warn(unavailableReason);

    const fallback = await clack.confirm({
      message: "Run locally instead?",
      initialValue: true,
    });

    if (clack.isCancel(fallback) || fallback) {
      return null; // Fall back to local
    }
    // User said "no" to fallback — try auth anyway (maybe availability is
    // temporarily wrong).
  }

  // ── Step 2: Browser-based auth ──────────────────────────────────────
  const authResult = await runCloudAuth(clack, resolvedBaseUrl);
  if (!authResult) {
    clack.log.warn("Cloud login was not completed.");

    const retry = await clack.confirm({
      message: "Try again, or run locally?",
      active: "Try again",
      inactive: "Run locally",
      initialValue: false,
    });

    if (clack.isCancel(retry) || !retry) {
      return null; // Fall back to local
    }

    // Retry auth once
    const retryResult = await runCloudAuth(clack, resolvedBaseUrl);
    if (!retryResult) {
      clack.log.warn("Login was not completed. Falling back to local mode.");
      return null;
    }

    // Use retry result
    return await finishProvisioning(
      clack,
      resolvedBaseUrl,
      retryResult,
      agentName,
      preset,
    );
  }

  return await finishProvisioning(
    clack,
    resolvedBaseUrl,
    authResult,
    agentName,
    preset,
  );
}

/**
 * Complete provisioning after successful auth.
 *
 * Branches on the explicit `ProvisionOutcome` kind: a "pending-after-
 * timeout" outcome is NOT treated as success — the caller is prompted
 * to fall back to local, the same as for outright failure, but the
 * agent id is preserved on the result so the user can reconnect later
 * with `eliza cloud connect`.
 */
async function finishProvisioning(
  clack: ClackModule,
  baseUrl: string,
  authResult: CloudLoginResult,
  agentName: string,
  preset?: StylePreset,
): Promise<CloudOnboardingResult | null> {
  // ── Step 3: Create + provision agent ──────────────────────────────
  const client = new ElizaCloudClient(baseUrl, authResult.apiKey);
  const provisionResult = await provisionCloudAgent(
    clack,
    client,
    agentName,
    preset,
  );

  if (provisionResult && provisionResult.kind === "running") {
    return {
      apiKey: authResult.apiKey,
      agentId: provisionResult.agentId,
      baseUrl,
      bridgeUrl: provisionResult.bridgeUrl,
    };
  }

  // Either provisioning errored (`null`) or timed out mid-flight.
  // Prompt the user to fall back. We preserve any agentId we got so
  // a later `eliza cloud connect` can resume.
  const pendingAgentId =
    provisionResult?.kind === "pending-after-timeout"
      ? provisionResult.agentId
      : undefined;

  clack.log.warn(
    pendingAgentId
      ? "Cloud agent is still starting up. You can try `eliza cloud connect` once it's ready."
      : "Cloud provisioning did not complete. You can try `eliza cloud connect` later.",
  );

  const runLocal = await clack.confirm({
    message: "Continue with local setup instead?",
    initialValue: true,
  });

  if (clack.isCancel(runLocal) || runLocal) {
    return null;
  }

  // User doesn't want local either — save the auth result (and the
  // pending agent id, if we have one) so they can reconnect later.
  return {
    apiKey: authResult.apiKey,
    agentId: pendingAgentId,
    baseUrl,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to open a URL in the user's default browser.
 * Falls back silently — the URL is also printed to the terminal.
 *
 * Uses execFile with an args array (not exec with string interpolation)
 * to avoid shell injection via crafted URLs.
 */
async function openBrowser(url: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { platform } = await import("node:os");

  const p = platform();

  return new Promise((resolve) => {
    const onError = (err: Error | null) => {
      if (err) {
        logger.debug(
          `[cloud-onboarding] Failed to open browser: ${err.message}`,
        );
      }
      resolve();
    };

    if (p === "darwin") {
      execFile("open", [url], onError);
    } else if (p === "win32") {
      execFile("cmd.exe", ["/c", "start", "", url], onError);
    } else {
      execFile("xdg-open", [url], onError);
    }
  });
}
