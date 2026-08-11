/**
 * Request-scoped iOS local-voice boot override. The simulator harness seeds a
 * native Preferences request before launch; after hydration and before React
 * mounts, this module makes that request authoritative over stale WKWebView
 * state and points the production client at the bundled-agent IPC transport.
 */
import type { ElizaClient } from "@elizaos/ui/api";
import { shellLocalStorage } from "@elizaos/ui/bridge";
import {
  IOS_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
} from "@elizaos/ui/first-run/mobile-runtime-mode";

export const IOS_VOICE_SELFTEST_REQUEST_KEY =
  "eliza:ios-voice-selftest:request";
export const IOS_VOICE_SELFTEST_RESULT_KEY = "eliza:ios-voice-selftest:result";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";
const LEGACY_REMOTE_API_BASE = "http://127.0.0.1:31338";
export const IOS_VOICE_SELFTEST_REQUEST_MAX_AGE_MS = 15 * 60_000;
export const IOS_VOICE_SELFTEST_REQUEST_FUTURE_SKEW_MS = 30_000;
const IOS_VOICE_SELFTEST_MAX_BUDGET_MS = 30 * 60_000;

export interface IosVoiceSelfTestRequest {
  mode: "local" | "remote";
  apiBase: string;
  runId: string;
  requestedAt: string | null;
  deadlineAt: string | null;
}

export const IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER = Object.freeze({
  id: MOBILE_LOCAL_AGENT_SERVER_ID,
  kind: "remote" as const,
  label: MOBILE_LOCAL_AGENT_LABEL,
  apiBase: IOS_LOCAL_AGENT_IPC_BASE,
});

export function parseIosVoiceSelfTestRequest(
  raw: string,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): IosVoiceSelfTestRequest {
  if (raw === "1") {
    return {
      mode: "remote",
      apiBase: LEGACY_REMOTE_API_BASE,
      runId: "legacy",
      requestedAt: null,
      deadlineAt: null,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request must be an object");
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    // error-policy:J2 preserve the parse cause while naming the native request
    throw new Error(
      `Invalid iOS voice self-test request: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const mode = parsed.mode === undefined ? "remote" : parsed.mode;
  if (mode !== "local" && mode !== "remote") {
    throw new Error(
      `Invalid iOS voice self-test mode: ${JSON.stringify(parsed.mode)}`,
    );
  }
  const apiBase =
    typeof parsed.apiBase === "string" && parsed.apiBase.trim()
      ? parsed.apiBase.trim()
      : mode === "local"
        ? IOS_LOCAL_AGENT_IPC_BASE
        : LEGACY_REMOTE_API_BASE;
  if (mode === "local" && apiBase !== IOS_LOCAL_AGENT_IPC_BASE) {
    throw new Error(
      `Local iOS voice self-test must use ${IOS_LOCAL_AGENT_IPC_BASE}, got ${apiBase}`,
    );
  }
  const runId =
    typeof parsed.runId === "string" && parsed.runId.trim()
      ? parsed.runId.trim()
      : "legacy";
  const requestedAt =
    typeof parsed.requestedAt === "string" &&
    Number.isFinite(Date.parse(parsed.requestedAt))
      ? parsed.requestedAt
      : null;
  const deadlineAt =
    typeof parsed.deadlineAt === "string" &&
    Number.isFinite(Date.parse(parsed.deadlineAt))
      ? parsed.deadlineAt
      : null;
  if (mode === "local" && runId === "legacy") {
    throw new Error("Local iOS voice self-test requires a nonlegacy runId");
  }
  if (mode === "local" && requestedAt === null) {
    throw new Error("Local iOS voice self-test requires a valid requestedAt");
  }
  if (
    mode === "local" &&
    (deadlineAt === null ||
      requestedAt === null ||
      Date.parse(deadlineAt) <= Date.parse(requestedAt) ||
      Date.parse(deadlineAt) - Date.parse(requestedAt) >
        IOS_VOICE_SELFTEST_MAX_BUDGET_MS)
  ) {
    throw new Error("Local iOS voice self-test requires a valid deadlineAt");
  }
  if (mode === "local" && requestedAt !== null) {
    const requestedAtMs = Date.parse(requestedAt);
    if (requestedAtMs < nowMs - IOS_VOICE_SELFTEST_REQUEST_MAX_AGE_MS) {
      throw new Error("Local iOS voice self-test request is stale");
    }
    if (requestedAtMs > nowMs + IOS_VOICE_SELFTEST_REQUEST_FUTURE_SKEW_MS) {
      throw new Error("Local iOS voice self-test request is from the future");
    }
  }
  return { mode, apiBase, runId, requestedAt, deadlineAt };
}

export async function applyIosVoiceSelfTestBootOverride({
  isIOS,
  client,
  getPreference,
}: {
  isIOS: boolean;
  client: Pick<ElizaClient, "setBaseUrl" | "setToken">;
  getPreference: (key: string) => Promise<string | null>;
}): Promise<boolean> {
  if (!isIOS) return false;
  let raw: string | null;
  try {
    raw = await getPreference(IOS_VOICE_SELFTEST_REQUEST_KEY);
  } catch {
    // error-policy:J4 a harness-only native read cannot brick normal app boot
    return false;
  }
  if (!raw) return false;
  let request: IosVoiceSelfTestRequest;
  try {
    request = parseIosVoiceSelfTestRequest(raw);
  } catch {
    // error-policy:J4 a harness-only request must never brick normal app boot;
    // the post-mount smoke boundary records the rejection and removes it
    return false;
  }
  if (request.mode !== "local") return false;

  shellLocalStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");
  shellLocalStorage.setItem(FIRST_RUN_COMPLETE_STORAGE_KEY, "1");
  shellLocalStorage.setItem(
    ACTIVE_SERVER_STORAGE_KEY,
    JSON.stringify(IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER),
  );
  client.setToken(null);
  client.setBaseUrl(IOS_LOCAL_AGENT_IPC_BASE);

  const modeReadback = window.localStorage.getItem(
    MOBILE_RUNTIME_MODE_STORAGE_KEY,
  );
  const serverReadback = window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
  if (
    modeReadback !== "local" ||
    serverReadback !== JSON.stringify(IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER)
  ) {
    throw new Error(
      "iOS voice self-test local boot override did not survive localStorage readback",
    );
  }
  return true;
}
