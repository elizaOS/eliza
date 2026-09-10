/**
 * Coordinates device first-run completion after its client connects to a remote
 * agent. Deep links and the Settings connection flow share this use case.
 * A successful status probe gates setup writes; transport or authorization
 * failures must preserve both host state and pending local onboarding intent.
 * Completed hosts are adopted without another setup write.
 */

import type { UiLanguage } from "../i18n";
import { buildFirstRunSubmitPlan } from "./first-run";
import { releasePendingFirstRunText } from "./first-run-pending-text";

/**
 * Normalizes a user- or link-supplied remote agent address into a canonical
 * `http(s)://host[:port]` URL, throwing a friendly message on anything invalid.
 * A bare `host:port` is upgraded to `https://`. Trailing slashes, query, and
 * hash are stripped so the same host always yields one identity.
 */
export function normalizeRemoteAgentUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a remote agent URL.");
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // error-policy:J3 untrusted user input — explicit invalid signal
    throw new Error("Enter a valid remote agent URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote agents must use HTTP or HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/** The minimal client surface this use case needs (a subset of `ElizaClient`). */
export interface RemoteFirstRunClient {
  getFirstRunStatus(): Promise<{ complete: boolean }>;
  submitFirstRun(data: Record<string, unknown>): Promise<void>;
}

export interface AdoptRemoteAgentFirstRunInput {
  /** The remote agent URL — already normalized/applied by the caller. */
  apiBase: string;
  /** Optional pre-shared access token for a pairing-disabled remote. */
  token?: string | null;
  /** Drives the default character preset language; defaults to English. */
  uiLanguage?: UiLanguage;
}

export interface AdoptRemoteAgentFirstRunResult {
  /** True when the remote already reported a completed first-run (no write). */
  alreadyComplete: boolean;
}

/**
 * Ensures the connected remote is recorded as the device's completed first-run
 * target. Returns whether the remote was already complete (so callers can skip
 * a redundant "configured" notice).
 *
 * Status and completion-write failures propagate to the connection UI before
 * local completion or pending text release.
 */
export async function adoptRemoteAgentFirstRun(
  client: RemoteFirstRunClient,
  input: AdoptRemoteAgentFirstRunInput,
): Promise<AdoptRemoteAgentFirstRunResult> {
  const alreadyComplete = (await client.getFirstRunStatus()).complete === true;

  if (alreadyComplete) {
    return { alreadyComplete: true };
  }

  const plan = buildFirstRunSubmitPlan({
    draft: {
      agentName: "",
      runtime: "remote",
      localInference: "all-local",
      remoteApiBase: input.apiBase,
      remoteToken: input.token ?? "",
    },
    uiLanguage: input.uiLanguage ?? "en",
  });

  await client.submitFirstRun(plan.payload);
  return { alreadyComplete: false };
}

/**
 * Adopts the remote, commits the local first-run gate, then releases any typed
 * onboarding requests to the real composer. A failed adoption performs neither
 * local completion nor release.
 */
export async function completeRemoteAgentFirstRun(
  client: RemoteFirstRunClient,
  input: AdoptRemoteAgentFirstRunInput,
  completeFirstRun: () => void,
): Promise<AdoptRemoteAgentFirstRunResult> {
  const result = await adoptRemoteAgentFirstRun(client, input);
  completeFirstRun();
  releasePendingFirstRunText();
  return result;
}
