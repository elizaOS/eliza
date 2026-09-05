import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import type { TechnocoreService } from "../services/technocore";

function getTechnocoreService(runtime: IAgentRuntime): TechnocoreService {
  const service = runtime.getService?.("technocore") as
    | TechnocoreService
    | undefined;
  if (!service) {
    throw new Error(
      "TechnocoreService is not registered or initialized in the runtime. Ensure technocorePlugin is added to plugins.",
    );
  }
  return service;
}

export function extractNamespace(
  runtime: IAgentRuntime,
  message?: Memory,
  options?: Record<string, unknown>,
): string {
  const content = message?.content as Record<string, unknown> | undefined;
  const customNs =
    (content?.namespace as string) ||
    (content?.ns as string) ||
    (options?.namespace as string) ||
    (options?.ns as string);
  if (
    typeof customNs === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(customNs.trim())
  ) {
    return customNs.trim();
  }

  const text = (content?.text as string) || "";
  const match = text.match(/\b(?:namespace|ns)\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (match?.[1]) {
    return match[1];
  }

  return (
    (runtime.getSetting?.("TECHNOCORE_DEFAULT_NS") as string) || "eliza-agent"
  );
}

export function extractKey(
  service: TechnocoreService,
  message?: Memory,
  options?: Record<string, unknown>,
): string {
  const content = message?.content as Record<string, unknown> | undefined;
  const customKey = (content?.key as string) || (options?.key as string);
  if (
    typeof customKey === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(customKey.trim())
  ) {
    return customKey.trim();
  }

  const text = (content?.text as string) || "";
  const match = text.match(/\bkey\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (match?.[1]) {
    return match[1];
  }

  // Default: partition by agent's unique DID to prevent multi-agent state collisions
  return service.did.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export const kvSetAction: Action = {
  name: "TECHNOCORE_KV_SET",
  similes: [
    "SAVE_TECHNOCORE_MEMORY",
    "SET_DECENTRALIZED_KV",
    "STORE_TECHNOCORE_STATE",
  ],
  description:
    "Stores a persistent memory entry in the Technocore decentralized Key-Value store.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content?.text || "";
    return /store\s+memory|save\s+to\s+kv|technocore\s+kv\s+set/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const text = message.content?.text || "";
      const value =
        typeof (message.content as Record<string, unknown>)?.value === "string"
          ? ((message.content as Record<string, unknown>).value as string)
          : text;

      const service = getTechnocoreService(runtime);
      const ns = extractNamespace(runtime, message, _options);
      const key = extractKey(service, message, _options);

      const result = await service.kvSet(ns, key, value);
      const responseText = `Successfully stored decentralized memory at /kv/${ns}/${key}`;

      if (callback) {
        callback({ text: responseText, action: "TECHNOCORE_KV_SET" });
      }

      return {
        success: true,
        text: responseText,
        data: result as unknown as ProviderDataRecord,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errMessage = `Failed to store Technocore KV: ${errMsg}`;
      if (callback) {
        callback({ text: errMessage, error: true });
      }
      return {
        success: false,
        error: errMessage,
      };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Save current agent goals to Technocore KV." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Storing agent goals in decentralized KV store...",
          action: "TECHNOCORE_KV_SET",
        },
      },
    ],
  ],
};

export const kvGetAction: Action = {
  name: "TECHNOCORE_KV_GET",
  similes: [
    "LOAD_TECHNOCORE_MEMORY",
    "GET_DECENTRALIZED_KV",
    "READ_TECHNOCORE_STATE",
  ],
  description:
    "Retrieves a persistent memory entry from the Technocore decentralized Key-Value store.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content?.text || "";
    return /read\s+memory|load\s+from\s+kv|technocore\s+kv\s+get/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTechnocoreService(runtime);
      const ns = extractNamespace(runtime, _message, _options);
      const key = extractKey(service, _message, _options);

      const result = await service.kvGet(ns, key);

      const responseText = `Retrieved Technocore KV memory from /kv/${ns}/${key}: ${result.value || "None"}`;

      if (callback) {
        callback({ text: responseText, action: "TECHNOCORE_KV_GET" });
      }

      return {
        success: true,
        text: responseText,
        data: result as unknown as ProviderDataRecord,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errMessage = `Failed to retrieve Technocore KV: ${errMsg}`;
      if (callback) {
        callback({ text: errMessage, error: true });
      }
      return {
        success: false,
        error: errMessage,
      };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Fetch saved memory from Technocore KV." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Retrieving memory from decentralized KV store...",
          action: "TECHNOCORE_KV_GET",
        },
      },
    ],
  ],
};
