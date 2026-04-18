import {
  logger,
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  injectCredentialToClipboard,
  listPasswordItems,
  searchPasswordItems,
  type PasswordManagerBridgeConfig,
  type PasswordManagerItem,
} from "../lifeops/password-manager-bridge.js";

/**
 * Password manager action.
 *
 * Owner-only. Subactions:
 *   - search: match items by query string.
 *   - list: return a bounded number of items.
 *   - inject_username / inject_password: copy a field to the OS clipboard.
 *
 * Plaintext credentials NEVER appear in chat or in ActionResult payloads.
 */

type PasswordManagerSubaction =
  | "search"
  | "list"
  | "inject_username"
  | "inject_password";

type PasswordManagerParameters = {
  subaction?: PasswordManagerSubaction | string;
  intent?: string;
  query?: string;
  itemId?: string;
  field?: "username" | "password";
  confirmed?: boolean;
  limit?: number;
};

/**
 * Infer a subaction from natural-language intent when the planner did not
 * pass one. Keeps the benchmark/common-path green without a planner-round-trip.
 */
function inferPasswordManagerSubaction(
  intent: string | undefined,
  messageText: string,
): PasswordManagerSubaction | "" {
  const haystack = `${intent ?? ""}\n${messageText ?? ""}`.toLowerCase();
  if (!haystack.trim()) return "";
  if (/\b(copy|paste|fill)\s+(the\s+)?password\b/.test(haystack)) {
    return "inject_password";
  }
  if (/\b(copy|paste|fill)\s+(the\s+)?username\b/.test(haystack)) {
    return "inject_username";
  }
  if (
    /\b(list|show|view|what\s+are\s+my)\b.*\b(logins|passwords|credentials|saved)\b/.test(
      haystack,
    ) ||
    /\b(saved\s+logins|all\s+logins)\b/.test(haystack)
  ) {
    return "list";
  }
  if (
    /\b(look\s*up|find|search|what(?:'s|\s+is)?|where\s+is)\b.*\b(login|password|credential)\b/.test(
      haystack,
    ) ||
    /\b(password\s+for|login\s+for|credential\s+for)\b/.test(haystack)
  ) {
    return "search";
  }
  return "";
}

function readConfig(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): PasswordManagerBridgeConfig {
  const account =
    process.env.ELIZA_1PASSWORD_ACCOUNT?.trim() ||
    (() => {
      const setting = runtime?.getSetting?.("ELIZA_1PASSWORD_ACCOUNT");
      return typeof setting === "string" ? setting.trim() : "";
    })();
  const config: PasswordManagerBridgeConfig = {};
  if (account) config.onePasswordAccount = account;
  return config;
}

function describeItems(items: PasswordManagerItem[]): string {
  if (items.length === 0) return "No matching items.";
  return items
    .map((item, index) => {
      const parts = [`${index + 1}. ${item.title} (id: ${item.id})`];
      if (item.url) parts.push(`url: ${item.url}`);
      if (item.username) parts.push(`username: ${item.username}`);
      return parts.join(" — ");
    })
    .join("\n");
}

function failure(error: string, extra?: Record<string, unknown>): ActionResult {
  const text =
    error === "PERMISSION_DENIED"
      ? "Password manager: permission denied — owner only."
      : error === "MISSING_QUERY"
        ? "Please tell me which site or login to search for (e.g., \"github\" or \"bank\")."
        : error === "MISSING_ITEM_ID"
          ? "Please identify which saved login to copy (search first to get an id)."
          : error === "CONFIRMATION_REQUIRED"
            ? "Password injection requires confirmed: true to copy to the clipboard."
            : error === "UNKNOWN_SUBACTION"
              ? "Password manager subaction unclear. Try: search <query>, list, inject_username, or inject_password."
              : `Password manager request could not complete (${error}).`;
  return {
    text,
    success: false,
    values: { success: false, error },
    data: { actionName: "PASSWORD_MANAGER", error, ...(extra ?? {}) },
  };
}

const examples: ActionExample[][] = [
  [
    { name: "{{user1}}", content: { text: "Find my GitHub login" } },
    {
      name: "{{agent}}",
      content: {
        text: "Searching your password manager for GitHub.",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
  [
    { name: "{{user1}}", content: { text: "Copy my AWS password to clipboard" } },
    {
      name: "{{agent}}",
      content: {
        text: "Copied the AWS password to your clipboard (clears in 30s).",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
  [
    { name: "{{user1}}", content: { text: "List my recent saved logins" } },
    {
      name: "{{agent}}",
      content: {
        text: "Here are your most recent saved items.",
        actions: ["PASSWORD_MANAGER"],
      },
    },
  ],
];

export const passwordManagerAction: Action = {
  name: "PASSWORD_MANAGER",
  similes: [
    "ONEPASSWORD",
    "CREDENTIAL_LOOKUP",
    "COPY_CREDENTIAL",
    "LOOK_UP_PASSWORD",
    "SHOW_SAVED_LOGINS",
    "LIST_LOGINS",
  ],
  description:
    "Look up or copy credentials from your password manager (1Password CLI or ProtonPass). " +
    "Use this for requests like 'look up my GitHub password' or 'show me my saved logins for github.com'. " +
    "Subactions: search, list, inject_username, inject_password. Credentials are NEVER displayed in chat — injection only copies to the OS clipboard briefly.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return failure("PERMISSION_DENIED");
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | PasswordManagerParameters
        | undefined) ?? {};

    const messageText =
      typeof (message?.content as { text?: unknown } | undefined)?.text === "string"
        ? ((message.content as { text: string }).text)
        : "";
    const explicitSubaction = (params.subaction ?? "").toString().trim().toLowerCase();
    const inferredSubaction = explicitSubaction
      ? ""
      : inferPasswordManagerSubaction(params.intent, messageText);
    const subaction = explicitSubaction || inferredSubaction;
    const config = readConfig(runtime);

    if (subaction === "search") {
      const query = (params.query ?? params.intent ?? "").toString().trim();
      if (!query) return failure("MISSING_QUERY");
      const items = await searchPasswordItems(query, config);
      const text = describeItems(items);
      return {
        text,
        success: true,
        values: { success: true, count: items.length },
        data: {
          actionName: "PASSWORD_MANAGER",
          subaction: "search",
          query,
          items,
        },
      };
    }

    if (subaction === "list") {
      const limit =
        typeof params.limit === "number" && params.limit > 0
          ? Math.floor(params.limit)
          : 20;
      const items = await listPasswordItems({ limit }, config);
      return {
        text: describeItems(items),
        success: true,
        values: { success: true, count: items.length },
        data: {
          actionName: "PASSWORD_MANAGER",
          subaction: "list",
          items,
        },
      };
    }

    if (subaction === "inject_username" || subaction === "inject_password") {
      const field: "username" | "password" =
        subaction === "inject_username" ? "username" : "password";
      const itemId = (params.itemId ?? "").toString().trim();
      if (!itemId) return failure("MISSING_ITEM_ID");
      if (params.confirmed !== true) {
        return failure("CONFIRMATION_REQUIRED", { itemId, field });
      }
      const result = await injectCredentialToClipboard(itemId, field, config);
      logger.info(
        { action: "PASSWORD_MANAGER", subaction, itemId, field },
        `[PASSWORD_MANAGER] Copied ${field} for item ${itemId} to clipboard`,
      );
      return {
        text: `Copied ${field} for item '${itemId}' to clipboard (clears in ${result.expiresInSeconds}s).`,
        success: true,
        values: {
          success: true,
          field,
          expiresInSeconds: result.expiresInSeconds,
        },
        data: {
          actionName: "PASSWORD_MANAGER",
          subaction,
          itemId,
          field,
          expiresInSeconds: result.expiresInSeconds,
        },
      };
    }

    return failure("UNKNOWN_SUBACTION", { subaction });
  },

  examples,

  parameters: [
    {
      name: "subaction",
      description:
        "One of: search, list, inject_username, inject_password.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description: "Natural-language description of the lookup intent.",
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Search string matched against item title, URL, username, and tags.",
      schema: { type: "string" as const },
    },
    {
      name: "itemId",
      description: "Password manager item id (required for inject_* subactions).",
      schema: { type: "string" as const },
    },
    {
      name: "field",
      description:
        "Which field to inject when using a generic inject subaction. Ignored when subaction explicitly names the field.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Must be explicitly true to copy a credential to the clipboard.",
      schema: { type: "boolean" as const },
    },
    {
      name: "limit",
      description: "Optional item limit for the `list` subaction (default 20).",
      schema: { type: "number" as const },
    },
  ],
};
