/** Receives authenticated profile-bound device commands from the signed remote host executor. */

import type { Route } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { parseRemoteBrowserCommandPayload } from "@elizaos/core/contracts/remote-control";
import { isBrowserDispatchFailure } from "../dispatch-types.js";

export const nativeDeviceBrowserRoute: Route = {
  type: "POST",
  path: "/api/browser-device/command",
  rawPath: true,
  modes: ["local", "local-only"],
  modeReason:
    "Device effects execute only on the authenticated local runtime, never a cloud tenant's host browser.",
  routeHandler: async ({ body, runtime, isTrustedLocal, inProcess }) => {
    if (!isTrustedLocal && !inProcess)
      return {
        status: 403,
        body: {
          error:
            "Native browser commands require the authenticated local device transport.",
        },
      };
    let request: ReturnType<typeof parseRemoteBrowserCommandPayload>;
    try {
      request = parseRemoteBrowserCommandPayload(body);
    } catch (error) {
      // error-policy:J3 malformed remote browser input never reaches a device.
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    const service = runtime.getService("browser");
    if (
      !service ||
      !("executeNativeDeviceCommand" in service) ||
      typeof service.executeNativeDeviceCommand !== "function"
    )
      return {
        status: 503,
        body: { error: "Native browser service is unavailable." },
      };
    try {
      const result = await service.executeNativeDeviceCommand(
        request.command,
        request.profileId,
      );
      return { status: 200, body: result };
    } catch (error) {
      // error-policy:J1 transport preserves uncertain dispatch and never retries the effect.
      return {
        status: 409,
        body: {
          error: error instanceof Error ? error.message : String(error),
          kind: isBrowserDispatchFailure(error)
            ? error.kind
            : "UNCERTAIN_OUTCOME",
        },
      };
    }
  },
};

export const nativeDeviceBrowserStatusRoute: Route = {
  type: "GET",
  path: "/api/browser-device",
  rawPath: true,
  modes: ["local", "local-only"],
  modeReason: "Profile identity belongs to the authenticated device runtime.",
  routeHandler: async ({ runtime }) => {
    const service = runtime.getService("browser");
    if (
      !service ||
      !("getNativeDeviceStatus" in service) ||
      typeof service.getNativeDeviceStatus !== "function"
    )
      return {
        status: 503,
        body: { error: "Native browser service is unavailable." },
      };
    return { status: 200, body: service.getNativeDeviceStatus() };
  },
};

interface SearchProfile {
  targetId: string;
  profileId: string;
}
function searchProfile(value: unknown): SearchProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  return typeof data.targetId === "string" && typeof data.profileId === "string"
    ? { targetId: data.targetId, profileId: data.profileId }
    : null;
}

export const nativeDeviceBrowserProfileRoutes: Route[] = (
  ["GET", "PUT"] as const
).map((method) => ({
  type: method,
  path: "/api/browser-device/profile",
  rawPath: true,
  modes: ["local", "local-only"],
  modeReason:
    "Search browser selection is scoped to the authenticated runtime agent.",
  routeHandler: async ({ runtime, body }) => {
    const service = runtime.getService("browser");
    if (
      !service ||
      !("getNativeDeviceStatus" in service) ||
      typeof service.getNativeDeviceStatus !== "function"
    )
      return {
        status: 503,
        body: { error: "Native browser service is unavailable." },
      };
    const status: unknown = service.getNativeDeviceStatus();
    const connected = searchProfile(status);
    if (method === "PUT") {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("selected" in body)
      )
        return {
          status: 400,
          body: { error: "selected must be a connected profile or null." },
        };
      const selected = searchProfile(body.selected);
      if (
        body.selected !== null &&
        (!selected ||
          !connected ||
          selected.profileId !== connected.profileId ||
          selected.targetId !== connected.targetId)
      )
        return {
          status: 409,
          body: { error: "Select the exact connected browser profile." },
        };
      const saved = await runtime.setCache(
        "browser.search-profile",
        selected ?? { disabled: true },
      );
      if (!saved)
        throw new ElizaError(
          "The agent's browser search profile could not be saved.",
          { code: "BROWSER_PROFILE_SAVE_FAILED" },
        );
      return { status: 200, body: { connected, selected } };
    }
    const stored = await runtime.getCache<unknown>("browser.search-profile");
    const selected = searchProfile(stored);
    if (
      stored !== undefined &&
      stored !== null &&
      !selected &&
      !(
        typeof stored === "object" &&
        !Array.isArray(stored) &&
        "disabled" in stored &&
        stored.disabled === true
      )
    )
      return {
        status: 500,
        body: { error: "The agent's saved browser search profile is invalid." },
      };
    return { status: 200, body: { connected, selected } };
  },
}));
