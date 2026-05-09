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
    const msg = String(err);
    spinner.stop(`Login failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent provisioning
// ---------------------------------------------------------------------------

/**
 * Create and provision a cloud agent, polling until it's running.
 * Returns the agent ID or null if provisioning fails.
 */
async function provisionCloudAgent(
  clack: ClackModule,
  client: ElizaCloudClient,
  agentName: string,
  preset?: StylePreset,
): Promise<{ agentId: string; bridgeUrl?: string } | null> {
  const spinner = clack.spinner();
  spinner.start("Creating your cloud agent...");

  try {
    // Build the agent config from the chosen style preset
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
    const agentId = agent.id;

    spinner.message("Agent created! Provisioning cloud environment...");

    // Poll for running status
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    let lastStatus = agent.status;

    while (Date.now() < deadline) {
      await sleep(PROVISION_POLL_INTERVAL_MS);

      try {
        const current = await client.getAgent(agentId);
        lastStatus = current.status;

        switch (lastStatus) {
          case "running":
          case "completed":
            spinner.stop(`☁️  Cloud agent "${agentName}" is running!`);
            return { agentId, bridgeUrl: current.bridgeUrl };

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
      } catch (pollErr) {
        // Transient polling error — keep trying
        logger.debug(`[cloud-onboarding] Poll error: ${String(pollErr)}`);
      }
    }

    // Timed out
    spinner.stop(
      `Provisioning timed out (last status: ${lastStatus}). The agent may still be starting up.`,
    );
    // Return the ID anyway — user can reconnect later
    return { agentId };
  } catch (err) {
    const msg = String(err);
    spinner.stop(`Failed to create cloud agent: ${msg}`);
    return null;
  }
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

  if (!provisionResult) {
    clack.log.warn(
      "Cloud provisioning did not complete. You can try `eliza cloud connect` later.",
    );

    const runLocal = await clack.confirm({
      message: "Continue with local setup instead?",
      initialValue: true,
    });

    if (clack.isCancel(runLocal) || runLocal) {
      return null;
    }

    // User doesn't want local either — just return the auth result
    // so config is saved (they can reconnect later)
    return {
      apiKey: authResult.apiKey,
      agentId: undefined, // No agent provisioned yet
      baseUrl,
    };
  }

  return {
    apiKey: authResult.apiKey,
    agentId: provisionResult.agentId,
    baseUrl,
    bridgeUrl: provisionResult.bridgeUrl,
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
