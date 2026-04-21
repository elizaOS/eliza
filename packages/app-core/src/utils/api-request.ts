import { DEFAULT_BOOT_CONFIG, getBootConfig } from "../config/boot-config";
import { getElizaApiToken } from "./eliza-globals";

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

const SESSION_STORAGE_API_TOKEN_KEY = "elizaos_api_token";

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSessionStorageToken(): string | null {
  const storage = globalThis.sessionStorage;
  if (!storage) {
    return null;
  }
  return readTrimmedString(storage.getItem(SESSION_STORAGE_API_TOKEN_KEY));
}

export function resolveCompatApiToken(): string | null {
  return (
    readSessionStorageToken() ??
    readTrimmedString(getBootConfig().apiToken) ??
    readTrimmedString(DEFAULT_BOOT_CONFIG.apiToken) ??
    readTrimmedString(getElizaApiToken()) ??
    null
  );
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let upstreamAbortListener: (() => void) | undefined;
  let timedOut = false;
  let aborted = false;

  if (init?.signal) {
    if (init.signal.aborted) {
      throw new Error("Request aborted");
    }
    upstreamAbortListener = () => {
      aborted = true;
      controller.abort();
    };
    init.signal.addEventListener("abort", upstreamAbortListener, {
      once: true,
    });
  }

  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    if (aborted) {
      throw new Error("Request aborted");
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Network request failed");
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (init?.signal && upstreamAbortListener) {
      init.signal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}
