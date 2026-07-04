/**
 * Headless "adopt a remote agent during first-run" use case.
 *
 * Device + desktop remote-connect-at-URL onboarding (deep link and the Settings
 * "Connect a remote agent" entry) funnels through here AFTER the client base has
 * been pointed at the remote (`applyLaunchConnection({ kind: "remote" })`). It
 * makes the connected remote the device's completed first-run target so the
 * startup poll lands on home instead of re-showing onboarding on the next launch.
 *
 * This is the headless equivalent of the legacy `finishRemote` step that used to
 * live in the full-screen onboarding controller, with one deliberate
 * improvement: it PROBES the remote's first-run status first and only writes
 * when the host has not finished its own first-run. Connecting to an
 * already-configured host therefore adopts it as-is instead of clobbering its
 * deployment target — the destructive overwrite the unconditional legacy POST
 * could cause.
 *
 * It is intentionally dependency-injected (the client surface is the only
 * dependency) so it can be unit-tested without the React shell or a live server.
 */

import type { UiLanguage } from "../i18n";
import { buildFirstRunSubmitPlan } from "./first-run";

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
 * Throws if the remote cannot be reached for the completion write — surfacing a
 * real connection failure rather than silently landing the user on a dead shell.
 */
export async function adoptRemoteAgentFirstRun(
  client: RemoteFirstRunClient,
  input: AdoptRemoteAgentFirstRunInput,
): Promise<AdoptRemoteAgentFirstRunResult> {
  let alreadyComplete = false;
  try {
    alreadyComplete = (await client.getFirstRunStatus()).complete === true;
  } catch {
    // error-policy:J4 a fresh host with no persisted first-run state, or one
    // whose build predates the status route, is the expected "needs adoption"
    // shape — fall through to the completion write below. A genuinely
    // unreachable remote re-fails there, so the failure still surfaces.
    alreadyComplete = false;
  }

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
