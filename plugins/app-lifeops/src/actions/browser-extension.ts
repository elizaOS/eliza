/**
 * Agent-side action that exposes browser-extension activity data to the
 * agent's reasoning loop.
 *
 * The browser extension self-registers via the HTTP endpoint
 * `POST /api/lifeops/browser/register` (handled in routes/lifeops-routes.ts);
 * the WebSocket activity stream is captured by the runtime-level
 * `BrowserExtensionBridge`. This action just surfaces the stored snapshot.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getBrowserActivitySnapshot } from "../lifeops/browser-extension-store.js";
import { hasLifeOpsAccess } from "./lifeops-google-helpers.js";

const FETCH_NAME = "FETCH_BROWSER_ACTIVITY";

interface FetchParameters {
  readonly deviceId?: string;
  readonly limit?: number;
}

function getParams<T>(options: HandlerOptions | undefined): T {
  const params = (options as HandlerOptions | undefined)?.parameters;
  return (params ?? {}) as T;
}

export const fetchBrowserActivityAction: Action = {
  name: FETCH_NAME,
  similes: ["BROWSER_ACTIVITY", "GET_BROWSER_ACTIVITY", "TIME_ON_SITE"],
  description:
    "Return the most recent per-domain focus time pushed by the LifeOps browser extension. Parameters: deviceId (optional), limit (optional, default 10).",
  descriptionCompressed:
    "Read last pushed per-domain focus seconds from extension cache optional device",

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
      typeof params.limit === "number" && params.limit > 0
        ? Math.floor(params.limit)
        : 10;
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
      (d) =>
        `- ${d.domain}: ${Math.round(d.focusMs / 1000)}s (${d.sessionCount} session${d.sessionCount === 1 ? "" : "s"})`,
    );
    const text = `Browser activity (device ${snapshot.deviceId ?? "any"}, window ending ${snapshot.windowEnd}):\n${lines.join("\n")}`;
    await callback?.({ text, source: "action", action: FETCH_NAME });
    return { text, success: true, data: { snapshot } };
  },

  parameters: [
    {
      name: "deviceId",
      description:
        "Filter to one registered device id; omit to use default active device.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Max domains to include (positive integer).",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "How much time did I spend on localhost today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Browser activity (per-domain focus)...",
          action: FETCH_NAME,
        },
      },
    ],
  ] as ActionExample[][],
};
