/**
 * Notifications prober.
 *
 * Native APIs (macOS):
 *   - check:   UNUserNotificationCenter.current().getNotificationSettings { settings.authorizationStatus }
 *   - request: UNUserNotificationCenter.current().requestAuthorization(options:)
 *
 * UNUserNotificationCenter binds authorization to the signed identity of the
 * process making the request. The Electrobun Bun host therefore carries the
 * parent app identifier; a helper identifier cannot request on its behalf.
 *
 * On win32/linux, concrete notification state is supplied by the renderer
 * fallback through Notification.permission.
 */

import { ElizaError } from "@elizaos/core";
import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  getNativeDylib,
  IS_DARWIN,
  mapUNAuthStatus,
} from "./_bridge.js";

const ID = "notifications" as const;
const AUTHORIZATION_POLL_INTERVAL_MS = 250;
const AUTHORIZATION_CHECK_TIMEOUT_MS = 2_000;
const AUTHORIZATION_REQUEST_TIMEOUT_MS = 30_000;
const NATIVE_NOTIFICATION_QUERY_PENDING = -2;

type NativeNotificationPermissionBridge = Pick<
  NonNullable<Awaited<ReturnType<typeof getNativeDylib>>>,
  "checkNotificationPermission" | "requestNotificationPermission"
>;

function nativeBridgeUnavailable(): ElizaError {
  return new ElizaError("macOS notification permission bridge is unavailable", {
    code: "NOTIFICATION_NATIVE_BRIDGE_UNAVAILABLE",
    severity: "fatal",
  });
}

export async function waitForAuthorizationDecision(
  lib: NativeNotificationPermissionBridge,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? AUTHORIZATION_REQUEST_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? AUTHORIZATION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let status = lib.requestNotificationPermission();
  while (status === 0 || status === NATIVE_NOTIFICATION_QUERY_PENDING) {
    if (Date.now() >= deadline) {
      throw new ElizaError(
        "Timed out waiting for macOS notification authorization",
        {
          code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
          context: { operation: "request", timeoutMs },
          severity: "ephemeral",
        },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = lib.checkNotificationPermission();
  }
  return status;
}

async function readAuthorizationStatus(
  lib: NativeNotificationPermissionBridge,
): Promise<number> {
  const deadline = Date.now() + AUTHORIZATION_CHECK_TIMEOUT_MS;
  let status = lib.checkNotificationPermission();
  while (status === NATIVE_NOTIFICATION_QUERY_PENDING) {
    if (Date.now() >= deadline) {
      throw new ElizaError(
        "Timed out reading macOS notification authorization",
        {
          code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
          context: {
            operation: "check",
            timeoutMs: AUTHORIZATION_CHECK_TIMEOUT_MS,
          },
          severity: "ephemeral",
        },
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, AUTHORIZATION_POLL_INTERVAL_MS),
    );
    status = lib.checkNotificationPermission();
  }
  return status;
}

function stateFromNativeStatus(
  status: number | undefined,
  lastRequested?: number,
): PermissionState {
  const mapped = mapUNAuthStatus(status ?? 0);
  return buildState(ID, mapped, {
    canRequest: mapped === "not-determined",
    lastRequested,
    restrictedReason: mapped === "restricted" ? "os_policy" : undefined,
  });
}

export const notificationsProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) {
      // Renderer fallback handles Notification.permission.
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lib = await getNativeDylib();
    if (!lib) throw nativeBridgeUnavailable();
    return stateFromNativeStatus(await readAuthorizationStatus(lib));
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) {
      return buildState(ID, "not-determined", { canRequest: true });
    }
    const lastRequested = Date.now();
    const lib = await getNativeDylib();
    if (!lib) throw nativeBridgeUnavailable();
    return stateFromNativeStatus(
      await waitForAuthorizationDecision(lib),
      lastRequested,
    );
  },
};
