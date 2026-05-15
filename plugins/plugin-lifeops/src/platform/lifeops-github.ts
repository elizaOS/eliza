import { asNonEmptyString, asRecord } from "@elizaos/shared";
import {
  dispatchLifeOpsGithubCallback,
  type LifeOpsGithubCallbackDetail,
} from "../events/index.js";

export const LIFEOPS_GITHUB_POST_MESSAGE_TYPE =
  "elizaos-lifeops-github-complete";

declare global {
  interface Window {
    __ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__?: LifeOpsGithubCallbackDetail[];
  }
}

function readTrimmedString(value: unknown): string | null {
  return asNonEmptyString(value) ?? null;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return undefined;
}

function normalizeLifeOpsGithubCallback(
  value: Record<string, unknown>,
): LifeOpsGithubCallbackDetail | null {
  const target = readTrimmedString(value.target);
  const status = readTrimmedString(value.status);
  if (
    (target !== "owner" && target !== "agent") ||
    (status !== "connected" && status !== "error")
  ) {
    return null;
  }

  const bindingMode = readTrimmedString(value.bindingMode);
  const restarted = readOptionalBoolean(value.restarted);

  return {
    target,
    status,
    connectionId: readTrimmedString(value.connectionId),
    agentId: readTrimmedString(value.agentId),
    githubUsername: readTrimmedString(value.githubUsername),
    bindingMode:
      bindingMode === "cloud-managed" || bindingMode === "shared-owner"
        ? bindingMode
        : null,
    message: readTrimmedString(value.message),
    restarted,
  };
}

function getCallbackQueue(): LifeOpsGithubCallbackDetail[] {
  if (typeof window === "undefined") {
    return [];
  }
  if (!Array.isArray(window.__ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__)) {
    window.__ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__ = [];
  }
  return window.__ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__;
}

function callbackKey(detail: LifeOpsGithubCallbackDetail): string {
  return JSON.stringify({
    target: detail.target,
    status: detail.status,
    connectionId: detail.connectionId ?? null,
    agentId: detail.agentId ?? null,
    githubUsername: detail.githubUsername ?? null,
    bindingMode: detail.bindingMode ?? null,
    message: detail.message ?? null,
    restarted: detail.restarted === true,
  });
}

export function readLifeOpsGithubCallbackFromWindowMessage(
  value: unknown,
): LifeOpsGithubCallbackDetail | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  if (payload.type !== LIFEOPS_GITHUB_POST_MESSAGE_TYPE) {
    return null;
  }
  return normalizeLifeOpsGithubCallback(payload);
}

export function readLifeOpsGithubCallbackFromUrl(
  url: string,
): LifeOpsGithubCallbackDetail | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "elizaos:") {
    return null;
  }

  const path = (parsed.pathname || parsed.host || "").replace(/^\/+/, "");
  if (path !== "lifeops" && path !== "settings") {
    return null;
  }

  return normalizeLifeOpsGithubCallback({
    target: parsed.searchParams.get("github_target"),
    status: parsed.searchParams.get("github_status"),
    connectionId: parsed.searchParams.get("connection_id"),
    agentId: parsed.searchParams.get("agent_id"),
    githubUsername: parsed.searchParams.get("github_username"),
    bindingMode: parsed.searchParams.get("binding_mode"),
    message: parsed.searchParams.get("message"),
    restarted: parsed.searchParams.get("restarted"),
  });
}

export function queueLifeOpsGithubCallback(
  detail: LifeOpsGithubCallbackDetail,
): void {
  if (typeof window === "undefined") {
    return;
  }
  getCallbackQueue().push(detail);
}

export function consumeQueuedLifeOpsGithubCallback(
  detail: LifeOpsGithubCallbackDetail,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const targetKey = callbackKey(detail);
  window.__ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__ = getCallbackQueue().filter(
    (candidate) => callbackKey(candidate) !== targetKey,
  );
}

export function drainLifeOpsGithubCallbacks(): LifeOpsGithubCallbackDetail[] {
  if (typeof window === "undefined") {
    return [];
  }
  const queued = [...getCallbackQueue()];
  window.__ELIZAOS_LIFEOPS_GITHUB_CALLBACK_QUEUE__ = [];
  return queued;
}

export function dispatchLifeOpsGithubCallbackFromWindowMessage(
  value: unknown,
): boolean {
  const detail = readLifeOpsGithubCallbackFromWindowMessage(value);
  if (!detail) {
    return false;
  }
  dispatchLifeOpsGithubCallback(detail);
  return true;
}

export function dispatchQueuedLifeOpsGithubCallbackFromUrl(
  url: string,
): boolean {
  const detail = readLifeOpsGithubCallbackFromUrl(url);
  if (!detail) {
    return false;
  }
  queueLifeOpsGithubCallback(detail);
  dispatchLifeOpsGithubCallback(detail);
  return true;
}
