/** Resolves heterogeneous DoorDash MCP tool names into one stable plugin contract. */

import { ElizaError } from "@elizaos/core";
import type {
  DoorDashCallResult,
  DoorDashMcpService,
  DoorDashOperation,
  DoorDashServerDescriptor,
  DoorDashToolResult,
} from "./types.js";

const TOOL_CANDIDATES: Record<DoorDashOperation, readonly string[]> = {
  status: ["doordash_auth_check", "login_check"],
  set_address: ["doordash_set_address"],
  clear_session: ["doordash_auth_clear"],
  search: ["doordash_search", "search_restaurants"],
  menu: ["doordash_menu", "get_store_menu"],
  add_to_cart: ["doordash_add_to_cart", "add_to_cart"],
  remove_from_cart: ["remove_from_cart"],
  cart: ["doordash_cart", "list_carts"],
  history: ["order_history"],
  preview_checkout: ["doordash_checkout"],
  place_order: ["doordash_checkout"],
  track_order: ["doordash_track_order"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function connectedDoorDashServers(
  service: DoorDashMcpService,
): DoorDashServerDescriptor[] {
  return service
    .getServers()
    .filter((server) => server.status === "connected")
    .filter(
      (server) =>
        server.name.toLowerCase() === "doordash" ||
        (server.tools ?? []).some((tool) =>
          tool.name.toLowerCase().includes("doordash"),
        ),
    );
}

function resolveServer(
  service: DoorDashMcpService,
  preferredServerName?: string,
): DoorDashServerDescriptor {
  const servers = connectedDoorDashServers(service);
  const preferred = preferredServerName?.trim().toLowerCase();
  const server = preferred
    ? servers.find((candidate) => candidate.name.toLowerCase() === preferred)
    : (servers.find(
        (candidate) => candidate.name.toLowerCase() === "doordash",
      ) ?? servers[0]);
  if (!server) {
    throw new ElizaError("No connected DoorDash MCP adapter is available.", {
      code: "DOORDASH_ADAPTER_UNAVAILABLE",
      severity: "ephemeral",
    });
  }
  return server;
}

function resolveTool(
  server: DoorDashServerDescriptor,
  operation: DoorDashOperation,
): string {
  const available = new Set((server.tools ?? []).map((tool) => tool.name));
  const selected = TOOL_CANDIDATES[operation].find((candidate) =>
    available.has(candidate),
  );
  if (!selected) {
    throw new ElizaError(
      `The connected DoorDash adapter does not support ${operation}.`,
      {
        code: "DOORDASH_OPERATION_UNSUPPORTED",
        context: { operation, serverName: server.name },
        severity: "ephemeral",
      },
    );
  }
  return selected;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ElizaError(`DoorDash ${key} is required.`, {
      code: "DOORDASH_INVALID_ARGUMENT",
      context: { argument: key },
      severity: "ephemeral",
    });
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = optionalNumber(args, key);
  if (value === undefined) {
    throw new ElizaError(`DoorDash ${key} must be a finite number.`, {
      code: "DOORDASH_INVALID_ARGUMENT",
      context: { argument: key },
      severity: "ephemeral",
    });
  }
  return value;
}

export function buildToolArguments(
  operation: DoorDashOperation,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (operation) {
    case "status":
    case "clear_session":
    case "cart":
      return {};
    case "set_address":
      return { address: requireString(args, "address") };
    case "search":
      return {
        query: requireString(args, "query"),
        ...(optionalString(args, "cuisine")
          ? { cuisine: optionalString(args, "cuisine") }
          : {}),
      };
    case "menu": {
      const restaurantId = requireString(args, "restaurantId");
      return toolName === "get_store_menu"
        ? {
            storeId: restaurantId,
            ...(optionalString(args, "menuId")
              ? { menuId: optionalString(args, "menuId") }
              : {}),
          }
        : { restaurantId };
    }
    case "add_to_cart": {
      const restaurantId = requireString(args, "restaurantId");
      const itemName = requireString(args, "itemName");
      const quantity = optionalNumber(args, "quantity") ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new ElizaError(
          "DoorDash quantity must be an integer from 1 through 99.",
          {
            code: "DOORDASH_INVALID_ARGUMENT",
            context: { argument: "quantity" },
            severity: "ephemeral",
          },
        );
      }
      if (toolName === "add_to_cart") {
        return {
          storeId: restaurantId,
          menuId: requireString(args, "menuId"),
          itemId: requireString(args, "itemId"),
          itemName,
          unitPrice: requireNumber(args, "unitPrice"),
          quantity,
          currency: optionalString(args, "currency") ?? "USD",
        };
      }
      return {
        restaurantId,
        itemName,
        quantity,
        ...(optionalString(args, "specialInstructions")
          ? { specialInstructions: optionalString(args, "specialInstructions") }
          : {}),
      };
    }
    case "remove_from_cart":
      return {
        cartId: requireString(args, "cartId"),
        itemId: requireString(args, "itemId"),
      };
    case "history":
      return { limit: optionalNumber(args, "limit") ?? 5 };
    case "preview_checkout":
      return { confirm: false };
    case "place_order":
      return { confirm: true };
    case "track_order":
      return optionalString(args, "orderId")
        ? { orderId: optionalString(args, "orderId") }
        : {};
  }
}

function parseToolResult(result: DoorDashToolResult): {
  value: unknown;
  text: string;
} {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  let value: unknown = text;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (result.isError) {
    throw new ElizaError(text || "DoorDash adapter returned an error.", {
      code: "DOORDASH_ADAPTER_ERROR",
      context: isRecord(value) ? value : undefined,
      severity: "ephemeral",
    });
  }
  if (isRecord(value) && value.success === false) {
    throw new ElizaError(
      text || "DoorDash adapter reported a failed operation.",
      {
        code: "DOORDASH_ADAPTER_ERROR",
        context: value,
        severity: "ephemeral",
      },
    );
  }
  return { value, text };
}

export async function callDoorDashOperation(
  service: DoorDashMcpService,
  operation: DoorDashOperation,
  args: Record<string, unknown>,
  preferredServerName?: string,
): Promise<DoorDashCallResult> {
  const server = resolveServer(service, preferredServerName);
  const toolName = resolveTool(server, operation);
  const toolArguments = buildToolArguments(operation, toolName, args);
  const parsed = parseToolResult(
    await service.callTool(server.name, toolName, toolArguments),
  );
  return {
    serverName: server.name,
    toolName,
    value: parsed.value,
    text: parsed.text,
  };
}

export function hasDoorDashCapability(
  service: DoorDashMcpService | null,
): boolean {
  return Boolean(service && connectedDoorDashServers(service).length > 0);
}
