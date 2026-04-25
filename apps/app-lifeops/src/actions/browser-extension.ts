/**
 * Agent-side actions that bridge the LifeOps browser extension to the
 * LifeOps agent runtime.
 *
 * REGISTER_BROWSER_SESSION
 *   Invoked when the extension announces itself at startup. Persists the
 *   deviceId and vendor metadata in the runtime cache so subsequent
 *   context requests can find the active browser session.
 *
 * FETCH_BROWSER_ACTIVITY
 *   Reads the most recent per-domain time report pushed by the
 *   extension. The actual WebSocket listener lives at the runtime level
 *   (see `BrowserExtensionBridge`); this action exposes the stored data
 *   to the agent's reasoning loop.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";
import {
  getBrowserActivitySnapshot,
  recordBrowserSessionRegistration,
  type BrowserSessionRegistration,
} from "../lifeops/browser-extension-store.js";

const REGISTER_NAME = "REGISTER_BROWSER_SESSION";
const FETCH_NAME = "FETCH_BROWSER_ACTIVITY";

interface RegisterParameters {
  readonly deviceId?: string;
  readonly userAgent?: string;
  readonly extensionVersion?: string;
  readonly browserVendor?: string;
}

interface FetchParameters {
  readonly deviceId?: string;
  readonly limit?: number;
}

function getParams<T>(options: HandlerOptions | undefined): T {
  const params = (options as HandlerOptions | undefined)?.parameters;
  return (params ?? {}) as T;
}

function toVendor(value: string | undefined): BrowserSessionRegistration["browserVendor"] {
  if (value === "chrome" || value === "safari") {
    return value;
  }
  return "unknown";
}

export const registerBrowserSessionAction: Action = {
  name: REGISTER_NAME,
  similes: ["BROWSER_EXTENSION_REGISTER", "ANNOUNCE_BROWSER_SESSION"],
  description:
    "Record that a LifeOps browser extension has announced itself. Parameters: deviceId, userAgent, extensionVersion, browserVendor.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Browser session registration is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams<RegisterParameters>(options);
    const deviceId = params.deviceId?.trim();
    if (!deviceId) {
      const text = "REGISTER_BROWSER_SESSION requires a deviceId.";
      await callback?.({ text });
      return { text, success: false, data: { error: "MISSING_DEVICE_ID" } };
    }

    const registration: BrowserSessionRegistration = {
      deviceId,
      userAgent: params.userAgent?.trim() ?? "",
      extensionVersion: params.extensionVersion?.trim() ?? "0.0.0",
      browserVendor: toVendor(params.browserVendor),
      registeredAt: new Date().toISOString(),
    };

    await recordBrowserSessionRegistration(runtime, registration);

    const text = `Registered browser session ${deviceId} (${registration.browserVendor}).`;
    await callback?.({ text, source: "action", action: REGISTER_NAME });
    return { text, success: true, data: { registration } };
  },
};

export const fetchBrowserActivityAction: Action = {
  name: FETCH_NAME,
  similes: ["BROWSER_ACTIVITY", "GET_BROWSER_ACTIVITY", "TIME_ON_SITE"],
  description:
    "Return the most recent per-domain focus time pushed by the LifeOps browser extension. Parameters: deviceId (optional), limit (optional, default 10).",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Browser activity is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams<FetchParameters>(options);
    const limit =
      typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 10;
    const snapshot = await getBrowserActivitySnapshot(runtime, {
      deviceId: params.deviceId?.trim(),
      limit,
    });

    if (snapshot.domains.length === 0) {
      const text = "No browser activity has been reported yet.";
      await callback?.({ text, source: "action", action: FETCH_NAME });
      return { text, success: true, data: { snapshot } };
    }

    const lines = snapshot.domains.map(
      (d) => `- ${d.domain}: ${Math.round(d.focusMs / 1000)}s (${d.sessionCount} session${d.sessionCount === 1 ? "" : "s"})`,
    );
    const text = `Browser activity (device ${snapshot.deviceId ?? "any"}, window ending ${snapshot.windowEnd}):\n${lines.join("\n")}`;
    await callback?.({ text, source: "action", action: FETCH_NAME });
    return { text, success: true, data: { snapshot } };
  },
};
